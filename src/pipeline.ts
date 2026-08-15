import { setTimeout as sleep } from 'node:timers/promises';

import type { BaseContext } from './context';
import { createContext } from './context';
import { createEngineAccessor } from './engine';
import type { Engine } from './engine';
import { PipelineError, StepError, UsageError } from './errors';
import { assertSafeName, describeError } from './internal';
import type { Logger } from './logger';
import { noopLogger } from './logger';
import { Step } from './step';
import type { SafeSpan, Tracing } from './tracing';
import {
  createTracing,
  recordAttemptOutcome,
  recordPipelineOutcome,
  recordPipelineStart,
  recordStepKey,
  recordStepOutcome,
  recordStepStart,
  recordUndoOutcome,
  recordUndoStart,
} from './tracing';
import type {
  AfterHook,
  AsStepOptions,
  BeforeHook,
  ErrorHook,
  LifecycleCallback,
  ParallelOptions,
  PipelineEntry,
  Result,
  RetryOptions,
  StepMeta,
  StepOptions,
  StepReport,
  TraceSpan,
  Tracer,
} from './types';

/**
 * Options for {@link Pipeline.execute} (section 3.2). `logger` selects the run logger
 * (default no-op), `throwOnError` rethrows a failure as a {@link PipelineError}
 * (section 1.7), and `dryRun` switches to planning instead of execution (section 1.2).
 */
export interface ExecuteOptions {
  throwOnError?: boolean;
  dryRun?: boolean;
  logger?: Logger;
  /**
   * Pipeline-level cancellation signal (section 1.3). It is bound to
   * `ctx.signal` for the whole run and folded into every invocation's
   * `meta.signal`, so steps can forward either into their own async work, and
   * it is checked between entries — an aborted signal stops the pipeline,
   * skips the remaining steps as `'cancelled'`, and rolls back completed ones.
   */
  signal?: AbortSignal;
  /**
   * Tracer for this run (0.4.0 spec, section 1.8). Omitted, no spans are
   * emitted at all; supplied, the run produces a pipeline span with a step
   * span per step, attempt spans for retrying steps, and a compensation span
   * per `undo`. Dry-run never emits spans. Every call penstock makes on the
   * tracer is contained: a tracer that throws is logged at `warn` and cannot
   * change the `Result`.
   */
  tracer?: Tracer;
  /**
   * Parent for this run's pipeline span (0.4.0 spec, section 1.8). Exported
   * because {@link Pipeline.asStep} sets it — nesting an inner pipeline's span
   * under the wrapping step's span — but usable directly to graft a penstock
   * run onto a span your own code already started.
   */
  parentSpan?: TraceSpan;
}

/** The originating failure captured when a step's `guard` or `run` throws. */
interface Failure<TContext extends BaseContext> {
  error: StepError;
  step: Step<TContext>;
  /**
   * The `'failed'` report just pushed, so the caller can close out the step's
   * span from the same facts the `Result` reports (0.4.0 spec, section 1.8).
   */
  report: StepReport;
}

/**
 * One level of the span tree, threaded through the executor: the run's span
 * factory plus the span new spans hang off. `execute` builds the pipeline-level
 * scope; each step builds a step-level one for its attempt spans. Bundling the
 * pair keeps the internals to a single extra parameter, and an untraced run
 * gets the inert factory so no path needs an `if (tracer)` branch.
 */
interface TraceScope {
  readonly tracing: Tracing;
  readonly span: SafeSpan;
}

/**
 * A completed step paired with its report, so rollback can update it in place,
 * and with the idempotency key its `run` was invoked under — the compensation's
 * key is that key plus `:undo` (0.4.0 spec, section 1.4).
 */
interface Completed<TContext extends BaseContext> {
  step: Step<TContext>;
  report: StepReport;
  idempotencyKey: string;
}

/**
 * Outcome of running a step's `run` under its retry policy (section 1.1) and
 * per-attempt timeout (section 1.2). `attempts` is how many times `run` was
 * actually called; `timedOut` reports whether the final failing attempt was
 * aborted by its timeout — both are recorded on the {@link StepReport}. The
 * `cancelled` variant is returned when the step's base signal ended the run —
 * a pipeline cancellation, or (for a parallel step) the group abort after a
 * peer failed: the run did not complete and is not a step failure, so the
 * caller stops rather than recording a failure.
 */
type RunOutcome =
  | { ok: true; attempts: number }
  | { ok: false; cancelled: true }
  | {
      ok: false;
      cancelled: false;
      attempts: number;
      error: unknown;
      timedOut: boolean;
    };

/**
 * Outcome of a single `run` attempt (section 1.2): success, or a failure tagged
 * with whether the per-attempt timeout fired.
 */
type AttemptResult =
  | { ok: true }
  | { ok: false; error: unknown; timedOut: boolean };

/**
 * Outcome of executing one pipeline entry — a sequential step or a parallel
 * group. `failed` carries the originating failures in declaration order:
 * exactly one for a sequential entry, one per failed step for a parallel group
 * (`result.error` is always the first). `cancelled` reports a pipeline
 * cancellation observed through the entry (section 1.3); the entry has already
 * pushed reports for its own steps, so `execute` marks only the entries after
 * it.
 */
type EntryOutcome<TContext extends BaseContext> =
  | { status: 'continue' }
  | { status: 'failed'; failures: Failure<TContext>[] }
  | { status: 'cancelled'; reason: Error };

/**
 * Settled state of one dispatched parallel step, keyed by its position in the
 * group. Filled as each task settles (completion order), then read back in
 * declaration order after `Promise.allSettled` so reports and rollback stay
 * deterministic (0.3.0 spec, sections 1.1.3 and 1.1.5). A step still queued in
 * a bounded pool when the group aborted was never dispatched and so has **no**
 * slot; it is classified like the `'cancelled'` kind (0.4.0 spec, section 1.5).
 */
type ParallelSlot =
  | {
      kind: 'completed';
      attempts: number;
      durationMs: number;
      idempotencyKey: string;
    }
  | {
      kind: 'failed';
      error: StepError;
      timedOut: boolean;
      durationMs: number;
      // Both are absent when the failure came from resolving the step's
      // idempotency key, which happens before the first attempt (section 1.4).
      attempts?: number;
      idempotencyKey?: string;
    }
  | { kind: 'cancelled' };

/**
 * How {@link Pipeline.executeStepRun} is being driven, which decides how an
 * abort seen through a failed attempt is classified:
 *
 * - `'sequential'` — the base signal is the pipeline signal, which only an
 *   external cancel can abort, so *any* abort observed through a failed
 *   attempt is a pipeline cancellation (section 1.3).
 * - `'parallel'` — the base signal is the group-combined signal, which also
 *   aborts when a *peer* fails (0.3.0 spec, section 1.1.3). A failed attempt
 *   counts as cancelled only when the rejection *is* the abort reason (a
 *   cooperative run forwarding `meta.signal`); a step's own genuine failure
 *   that merely races the group abort stays a failure.
 */
type RunMode = 'sequential' | 'parallel';

/**
 * An ordered, named collection of steps (section 3.2). It threads one context through
 * its entries — sequential steps and parallel groups (0.3.0 spec, section 1.1)
 * — evaluates guards, fires observer hooks, and — when a step fails —
 * performs best-effort, reverse-order rollback (section 1.7) before returning
 * a structured {@link Result}. The instance holds only immutable config; every
 * piece of per-run state lives in {@link Pipeline.execute}-local variables, so
 * a pipeline is safe to `execute` repeatedly and concurrently (section 3.2
 * re-entrancy).
 *
 * Pipeline-scoped engines (section 3.5) shadow the global registry, and `dryRun`
 * planning is available via {@link Pipeline.execute} (section 1.2).
 */
export class Pipeline<TContext extends BaseContext = BaseContext> {
  readonly name: string;
  // The execution sequence: sequential steps and parallel groups, each
  // occupying one position (0.3.0 spec, section 1.1.6).
  private readonly entries: PipelineEntry<TContext>[] = [];
  // Step-name dedup uses a Set, never a user-keyed plain object (section 1.10).
  private readonly stepNames = new Set<string>();
  // Pipeline-scoped engines, Map-backed for the same reason (section 1.10). Build-time
  // config (set via useEngine), read-only during execute — not per-run state.
  private readonly engines = new Map<string, Engine>();
  private readonly beforeHooks: BeforeHook<TContext>[] = [];
  private readonly afterHooks: AfterHook<TContext>[] = [];
  private readonly errorHooks: ErrorHook<TContext>[] = [];
  // Lifecycle callbacks (0.3.0 spec, section 1.3), array-backed like the
  // hooks: multiple per type, fired in registration order.
  private readonly completeCallbacks: LifecycleCallback<TContext>[] = [];
  private readonly failureCallbacks: LifecycleCallback<TContext>[] = [];
  private readonly cancelCallbacks: LifecycleCallback<TContext>[] = [];
  private readonly settledCallbacks: LifecycleCallback<TContext>[] = [];

  constructor(name: string) {
    // Empty / non-string / reserved name → UsageError, synchronously (section 1.10).
    assertSafeName('Pipeline', name);
    this.name = name;
  }

  /**
   * Appends a sequential step. Throws a `UsageError` synchronously if `step` is
   * not a `Step` or its name duplicates one already in this pipeline (section 3.2).
   */
  addStep(step: Step<TContext>): this {
    if (!(step instanceof Step)) {
      throw new UsageError('Pipeline.addStep expects a Step instance');
    }
    if (this.stepNames.has(step.name)) {
      throw new UsageError(
        `Pipeline "${this.name}" already has a step named "${step.name}"`,
      );
    }
    this.stepNames.add(step.name);
    this.entries.push({ kind: 'sequential', step });
    return this;
  }

  /**
   * Inserts a parallel group (0.3.0 spec, section 1.1): the given steps run
   * concurrently, occupying one logical position in the pipeline. Requires at
   * least 2 steps, each a `Step` whose name is unique across the whole
   * pipeline. The group is validated in full before any of it is registered,
   * so a throwing call leaves the pipeline unchanged. Chainable.
   *
   * `options.concurrency` caps how many of the group's steps run at once
   * (0.4.0 spec, section 1.5); it must be an integer `>= 1`. Omitting it — or
   * setting it at or above the group size — runs everything at once, which is
   * exactly the 0.3.0 behaviour.
   */
  addParallel(steps: Step<TContext>[], options?: ParallelOptions): this {
    if (!Array.isArray(steps) || steps.length < 2) {
      throw new UsageError(
        `Pipeline "${this.name}" addParallel requires at least 2 steps`,
      );
    }
    // A bad limit is misuse, so it fails fast and synchronously like every
    // other build-time check (section 1.5). `Number.isInteger` also rejects
    // NaN, fractions, Infinity, and non-numbers.
    const concurrency = options?.concurrency;
    if (
      concurrency !== undefined &&
      (!Number.isInteger(concurrency) || concurrency < 1)
    ) {
      throw new UsageError(
        `Pipeline "${this.name}" addParallel concurrency must be an integer greater than or equal to 1`,
      );
    }
    const incoming = new Set<string>();
    for (const step of steps) {
      if (!(step instanceof Step)) {
        throw new UsageError('Pipeline.addParallel expects Step instances');
      }
      if (this.stepNames.has(step.name) || incoming.has(step.name)) {
        throw new UsageError(
          `Pipeline "${this.name}" already has a step named "${step.name}"`,
        );
      }
      incoming.add(step.name);
    }
    for (const name of incoming) {
      this.stepNames.add(name);
    }
    // Keep the limit truly absent when not supplied (mirrors Step's options).
    this.entries.push(
      concurrency === undefined
        ? { kind: 'parallel', steps: [...steps] }
        : { kind: 'parallel', steps: [...steps], concurrency },
    );
    return this;
  }

  /**
   * Wraps this whole pipeline as a single `Step` of an outer pipeline (0.3.0
   * spec, section 1.2). The returned step is a **regular `Step`** — usable
   * with `.when()`, `addStep`, or inside `addParallel` — whose `run`:
   *
   * 1. derives the inner input via `mapInput(outerCtx)`;
   * 2. executes this pipeline on its **own fresh, isolated context**, with
   *    the outer run's logger and the wrapping step's own `meta.signal` (so an
   *    outer cancel — or, inside a parallel group, a peer failure, or the
   *    wrapping step's own timeout — propagates into the inner run, which
   *    `ctx.signal` alone no longer carries: 0.4.0 spec, section 1.3),
   *    resolving engines from this pipeline's own `useEngine`
   *    registrations plus the global registry — never the outer pipeline's
   *    scoped engines;
   * 3. on inner success calls `mapResult(innerResult, outerCtx)`;
   * 4. on inner failure throws the inner `result.error` — the inner pipeline
   *    has already rolled its own completed steps back inside `execute`, so
   *    the outer pipeline wraps that error in its usual `StepError` and rolls
   *    back only *outer* steps (section 1.2.4, scenario A). If the outer run
   *    was cancelled, the wrapping step is classified `'cancelled'` like any
   *    other step whose run ends under an aborted signal (section 1.3).
   *
   * Either way the inner `Result` is surfaced as `innerResult` on the
   * wrapping step's report (section 1.2.5). During **outer** rollback the
   * wrapping step is compensated only by `options.undo`, if given — the inner
   * pipeline is never re-rolled-back (section 1.2.4, scenario B).
   */
  asStep<TOuterContext extends BaseContext>(
    name: string,
    options: AsStepOptions<TOuterContext, TContext['input']>,
  ): Step<TOuterContext> {
    if (typeof options?.mapInput !== 'function') {
      throw new UsageError(
        `Pipeline "${this.name}" asStep "${name}" requires a mapInput function`,
      );
    }
    const run = async (
      outerCtx: TOuterContext,
      meta: StepMeta,
    ): Promise<void> => {
      const innerInput = options.mapInput(outerCtx);
      const innerOptions: ExecuteOptions = {
        logger: outerCtx.logger,
        signal: meta.signal,
      };
      // The inner run is a separate execution with its own pipeline span; it
      // is parented to the wrapping step's span so the trace mirrors the
      // composition (0.4.0 spec, section 1.8). Both handles come from the
      // outer run, which published them for exactly this purpose.
      const handle = traceHandles.get(outerCtx);
      if (handle !== undefined) {
        innerOptions.tracer = handle.tracer;
        const parentSpan = handle.spans.get(name);
        if (parentSpan !== undefined) {
          innerOptions.parentSpan = parentSpan;
        }
      }
      const innerResult = await this.execute(innerInput, innerOptions);
      // Recorded before the failure throw so the executor can attach it to
      // the wrapping step's report whatever the outcome.
      storeInnerResult(outerCtx, name, innerResult);
      if (!innerResult.ok) {
        throw innerResult.error;
      }
      if (options.mapResult) {
        options.mapResult(innerResult, outerCtx);
      }
    };
    const stepOptions: StepOptions<TOuterContext> = { run };
    if (options.when !== undefined) {
      stepOptions.when = options.when;
    }
    if (options.undo !== undefined) {
      stepOptions.undo = options.undo;
    }
    // The Step constructor validates the name (non-empty, non-reserved).
    return new Step<TOuterContext>(name, stepOptions);
  }

  /** Registers a `before` observer hook; multiple are allowed (section 3.2). */
  before(hook: BeforeHook<TContext>): this {
    this.beforeHooks.push(hook);
    return this;
  }

  /** Registers an `after` observer hook; multiple are allowed (section 3.2). */
  after(hook: AfterHook<TContext>): this {
    this.afterHooks.push(hook);
    return this;
  }

  /** Registers an `onError` observer hook; multiple are allowed (section 3.2). */
  onError(hook: ErrorHook<TContext>): this {
    this.errorHooks.push(hook);
    return this;
  }

  /**
   * Registers a lifecycle callback fired when a run **succeeds**
   * (`result.ok === true`) — before the `onSettled` callbacks (0.3.0 spec,
   * section 1.3). Multiple are allowed; they run in registration order.
   */
  onComplete(callback: LifecycleCallback<TContext>): this {
    this.completeCallbacks.push(callback);
    return this;
  }

  /**
   * Registers a lifecycle callback fired when a run fails because a **step
   * (or guard) failed** — not a cancellation (`result.aborted` separates the
   * two). Fires after rollback is complete, before `onSettled` (0.3.0 spec,
   * section 1.3).
   */
  onFailure(callback: LifecycleCallback<TContext>): this {
    this.failureCallbacks.push(callback);
    return this;
  }

  /**
   * Registers a lifecycle callback fired when a run was **stopped by its
   * `AbortSignal`** (`result.aborted === true`). Fires after rollback is
   * complete, before `onSettled` (0.3.0 spec, section 1.3).
   */
  onCancel(callback: LifecycleCallback<TContext>): this {
    this.cancelCallbacks.push(callback);
    return this;
  }

  /**
   * Registers a lifecycle callback fired **always**, last — after the
   * outcome-specific `onComplete` / `onFailure` / `onCancel` callbacks: the
   * `finally` of the family (0.3.0 spec, section 1.3).
   */
  onSettled(callback: LifecycleCallback<TContext>): this {
    this.settledCallbacks.push(callback);
    return this;
  }

  /**
   * Registers an engine scoped to this pipeline; during resolution it shadows a
   * global engine of the same name (section 3.5). The scoped store is a `Map`, never a
   * user-keyed plain object (section 1.10). Chainable.
   */
  useEngine(engine: Engine): this {
    this.engines.set(engine.name, engine);
    return this;
  }

  /**
   * Builds a fresh context for this call, runs each entry in order, and resolves
   * with a {@link Result}. On a step failure the flow aborts, `onError` fires
   * per originating failure, completed steps are compensated in reverse order
   * (section 1.7), and the `Result` carries `ok:false` with the failure and any
   * rollback errors. With `{ throwOnError: true }` the same failure is thrown as
   * a {@link PipelineError} instead. With `{ dryRun: true }` it plans instead of
   * executing (section 1.2). Per section 3.2 all run state is local to this method.
   */
  async execute(
    input: TContext['input'],
    options: ExecuteOptions = {},
  ): Promise<Result<TContext>> {
    // Covers everything the call does, rollback included (section 1.7).
    const startedAt = performance.now();
    const logger = options.logger ?? noopLogger;
    // ctx.engines resolves pipeline-scoped engines first, then the global
    // registry, throwing UsageError on an unknown name (section 3.5, section 1.10).
    const ctx = createContext(
      input,
      createEngineAccessor(this.engines),
      logger,
      options.signal,
    ) as TContext;
    if (options.dryRun) {
      // Planning, not execution (section 1.2): no run/undo, no hooks, no
      // rollback — and no spans either (0.4.0 spec, section 1.8), which is why
      // this returns before any tracing is set up.
      return this.plan(ctx, logger, startedAt);
    }
    // Tracing is per-run state like every other execute-local variable (section
    // 3.2). An untraced run gets the inert factory rather than a null check.
    const tracing = createTracing(options.tracer, logger);
    const pipelineSpan = tracing.pipeline(this.name, options.parentSpan);
    const trace: TraceScope = { tracing, span: pipelineSpan };
    if (options.tracer !== undefined) {
      // Published for the whole run so a pipeline-as-step can parent its inner
      // run's span to the wrapping step's span (section 1.8). Keyed by this
      // call's context, so concurrent runs never share it (section 3.2).
      traceHandles.set(ctx, {
        tracer: options.tracer,
        spans: new Map<string, TraceSpan>(),
      });
    }
    try {
      recordPipelineStart(
        pipelineSpan,
        this.name,
        ctx.executionId,
        // Every step's name is registered there, so its size is the step
        // count — parallel groups expanded.
        this.stepNames.size,
      );
      return await this.runToResult(ctx, options, logger, trace, startedAt);
    } finally {
      // The one place the pipeline span is ended, so no path can leak it —
      // including `throwOnError`, which throws out of the call above (section 1.8).
      pipelineSpan.end();
    }
  }

  /**
   * The body of {@link Pipeline.execute}, split out so the pipeline span's
   * lifetime is a single `try`/`finally` around one call. Per section 3.2 all
   * run state is local to this method.
   */
  private async runToResult(
    ctx: TContext,
    options: ExecuteOptions,
    logger: Logger,
    trace: TraceScope,
    startedAt: number,
  ): Promise<Result<TContext>> {
    const steps: StepReport[] = [];
    // Steps whose `run` completed, in execution order — parallel steps are
    // registered in declaration order once their group settles. Walked
    // newest-first during rollback (section 1.7); local for re-entrancy (section 3.2).
    const completed: Completed<TContext>[] = [];
    // Originating failures, in declaration order. A sequential entry
    // contributes at most one; a parallel group may contribute one per failed
    // step. `result.error` is always the first.
    let failures: Failure<TContext>[] = [];
    // Set when a pipeline cancellation is detected (section 1.3) — between
    // entries, during a retry delay, or mid-parallel-group. Holds the abort
    // reason, which is surfaced as `result.error`.
    let cancellation: { reason: Error } | null = null;

    for (let i = 0; i < this.entries.length; i++) {
      // Pipeline cancellation is checked only *between* entries (section 1.3); we
      // never interrupt user code mid-run. If the signal is already aborted, this
      // entry and every remaining one are skipped as 'cancelled', then completed
      // steps roll back with the abort reason.
      if (ctx.signal.aborted) {
        cancellation = { reason: ctx.signal.reason };
        this.markCancelled(i, steps, logger, trace);
        break;
      }
      const entry = this.entries[i]!;
      let outcome: EntryOutcome<TContext>;
      if (entry.kind === 'sequential') {
        outcome = await this.executeSequentialEntry(
          entry.step,
          ctx,
          steps,
          completed,
          logger,
          trace,
        );
      } else {
        outcome = await this.executeParallelEntry(
          entry.steps,
          entry.concurrency,
          ctx,
          steps,
          completed,
          logger,
          trace,
        );
      }
      if (outcome.status === 'failed') {
        failures = outcome.failures;
        break;
      }
      if (outcome.status === 'cancelled') {
        // The entry saw the cancel itself (a woken retry delay, a cooperative
        // run, or a cancel during a parallel group) and has already reported
        // its own steps; mark only the entries after it.
        cancellation = { reason: outcome.reason };
        this.markCancelled(i + 1, steps, logger, trace);
        break;
      }
    }

    if (cancellation) {
      // Cancellation rolls back completed steps exactly like a failure (section
      // 1.3) but fires no `onError`: there is no originating step failure, and
      // the pre-aborted case has no step to hand the hook. The abort reason is
      // surfaced unwrapped as `result.error` (and `PipelineError.cause` under
      // `throwOnError`) — not wrapped in a StepError.
      const rollbackErrors = await this.rollback(completed, ctx, logger, trace);
      const result = this.buildResult(ctx, steps, startedAt, {
        ok: false,
        error: cancellation.reason,
        rollbackErrors,
        aborted: true,
      });
      recordPipelineOutcome(trace.span, result);
      await this.fireLifecycle(result, logger);
      if (options.throwOnError) {
        throw this.toPipelineError(result);
      }
      return result;
    }

    if (failures.length > 0) {
      // `onError` fires BEFORE rollback (section 1.7), once per originating
      // failure — a parallel group may have several, in declaration order.
      for (const { error, step } of failures) {
        await this.runHooks(
          this.errorHooks,
          (hook) => hook(error, ctx, step),
          'onError',
          step.name,
          logger,
        );
      }
      const rollbackErrors = await this.rollback(completed, ctx, logger, trace);
      const result = this.buildResult(ctx, steps, startedAt, {
        ok: false,
        error: failures[0]!.error,
        rollbackErrors,
        aborted: false,
      });
      recordPipelineOutcome(trace.span, result);
      await this.fireLifecycle(result, logger);
      if (options.throwOnError) {
        throw this.toPipelineError(result);
      }
      return result;
    }

    const result = this.buildResult(ctx, steps, startedAt, {
      ok: true,
      error: null,
      rollbackErrors: [],
      aborted: false,
    });
    recordPipelineOutcome(trace.span, result);
    await this.fireLifecycle(result, logger);
    return result;
  }

  /**
   * Assembles the final {@link Result}, stamping the fields every run carries
   * however it ended: the execution identity (section 1.1), this pipeline's
   * name, and the total wall-clock duration measured from the top of
   * `execute` — so it includes rollback (section 1.7).
   */
  private buildResult(
    ctx: TContext,
    steps: StepReport[],
    startedAt: number,
    outcome: {
      ok: boolean;
      error: Error | null;
      rollbackErrors: Error[];
      aborted: boolean;
    },
  ): Result<TContext> {
    return {
      ok: outcome.ok,
      context: ctx,
      steps,
      error: outcome.error,
      rollbackErrors: outcome.rollbackErrors,
      aborted: outcome.aborted,
      executionId: ctx.executionId,
      pipelineName: this.name,
      durationMs: performance.now() - startedAt,
    };
  }

  /**
   * Executes one sequential step: guard, `before` hooks, the run under its
   * retry/timeout policy, then the report and `after` hooks. A throwing guard
   * is a step failure — the guard is the only flow-control mechanism (section
   * 1.8) and is evaluated before any hook. A cancellation surfacing through
   * the run (a woken retry delay or a cooperative run, section 1.3) records
   * the step as `'cancelled'` and stops the pipeline.
   *
   * The step's span (0.4.0 spec, section 1.8) brackets the whole of that —
   * guard included, since a throwing guard is a step failure — and is closed
   * in a `finally`, so no outcome can leak it. Every exit stamps the span from
   * the very report it pushed, keeping the trace and the `Result` in step.
   */
  private async executeSequentialEntry(
    step: Step<TContext>,
    ctx: TContext,
    steps: StepReport[],
    completed: Completed<TContext>[],
    logger: Logger,
    trace: TraceScope,
  ): Promise<EntryOutcome<TContext>> {
    const span = trace.tracing.step(step.name, trace.span);
    try {
      recordStepStart(span, step.name);
      // Published while the step runs so a pipeline-as-step nests its inner
      // run under this span (section 1.8).
      bindStepSpan(ctx, step.name, span);

      let shouldRun = true;
      if (step.guard) {
        const guardStart = performance.now();
        try {
          shouldRun = await step.guard(ctx);
        } catch (raw) {
          const failure = this.recordFailure(
            ctx,
            step,
            raw,
            performance.now() - guardStart,
            steps,
            logger,
          );
          recordStepOutcome(span, failure.report);
          return { status: 'failed', failures: [failure] };
        }
      }
      if (!shouldRun) {
        recordStepOutcome(span, this.pushGuardSkip(step, steps, logger));
        return { status: 'continue' };
      }

      await this.runHooks(
        this.beforeHooks,
        (hook) => hook(ctx, step),
        'before',
        step.name,
        logger,
      );

      const start = performance.now();
      // Resolved once per invocation, before the first attempt, and reused for
      // every retry (0.4.0 spec, section 1.4). A throwing key function is a step
      // failure like any other user-code throw — the run never happens, so the
      // report carries neither an attempt count nor a key.
      let idempotencyKey: string;
      try {
        idempotencyKey = resolveIdempotencyKey(step, ctx);
      } catch (raw) {
        const failure = this.recordFailure(
          ctx,
          step,
          raw,
          performance.now() - start,
          steps,
          logger,
        );
        recordStepOutcome(span, failure.report);
        return { status: 'failed', failures: [failure] };
      }
      recordStepKey(span, idempotencyKey);
      // Run with the step's retry policy (section 1.1); only `run` is retried.
      const outcome = await this.executeStepRun(
        step,
        ctx,
        ctx.signal,
        'sequential',
        idempotencyKey,
        { tracing: trace.tracing, span },
      );
      const durationMs = performance.now() - start;
      if (!outcome.ok) {
        if (outcome.cancelled) {
          // The step never completed, so it is recorded 'cancelled' alongside
          // the entries `execute` marks after it (section 1.3). A cancelled
          // pipeline-as-step still surfaces its inner Result, showing the inner
          // pipeline's own cancellation handling (0.3.0 spec, section 1.2.4 C).
          const report: StepReport = {
            name: step.name,
            status: 'skipped',
            durationMs: 0,
            skipReason: 'cancelled',
          };
          attachInnerResult(ctx, report);
          steps.push(report);
          recordStepOutcome(span, report);
          logger.debug('step skipped', {
            stepName: step.name,
            status: 'skipped',
          });
          return { status: 'cancelled', reason: ctx.signal.reason };
        }
        const failure = this.recordFailure(
          ctx,
          step,
          outcome.error,
          durationMs,
          steps,
          logger,
          {
            attempts: outcome.attempts,
            timedOut: outcome.timedOut,
            idempotencyKey,
          },
        );
        recordStepOutcome(span, failure.report);
        return { status: 'failed', failures: [failure] };
      }

      // Keep the report by reference so rollback can flip its status in place.
      const report: StepReport = {
        name: step.name,
        status: 'completed',
        durationMs,
        attempts: outcome.attempts,
        idempotencyKey,
      };
      attachInnerResult(ctx, report);
      steps.push(report);
      completed.push({ step, report, idempotencyKey });
      // Stamped now, while the report still says 'completed': a later rollback
      // rewrites it in place, and that is what the `undo` span records.
      recordStepOutcome(span, report);
      logger.debug('step completed', {
        stepName: step.name,
        status: 'completed',
        durationMs,
      });

      await this.runHooks(
        this.afterHooks,
        (hook) => hook(ctx, step, { status: 'completed', durationMs }),
        'after',
        step.name,
        logger,
      );
      return { status: 'continue' };
    } finally {
      unbindStepSpan(ctx, step.name);
      span.end();
    }
  }

  /**
   * Executes a parallel group (0.3.0 spec, sections 1.1.2–1.1.3) in three
   * phases:
   *
   * 1. **Guards, sequentially,** in declaration order, before any concurrent
   *    work. A falsy guard excludes its step from the batch; a throwing guard
   *    aborts the whole group before anything runs (steps already
   *    guard-skipped keep their reports; steps cleared to run never started
   *    and get none — same as steps after a sequential failure).
   * 2. **Concurrent execution** of the cleared steps, through a bounded pool
   *    of at most `concurrency` slots (0.4.0 spec, section 1.5; unbounded when
   *    the option is omitted). Every step's runs are driven by a signal
   *    combining two cancellation levels: a group-scoped `AbortController`
   *    (aborted as soon as any peer fails) and the pipeline signal (external
   *    cancellation). `before` hooks fire per step at dispatch (declaration
   *    order — dispatching is sequential; only the runs overlap); `after`
   *    hooks fire per step as it completes (completion order).
   *    `Promise.allSettled` — never `Promise.all` — waits for every dispatched
   *    step to settle before anything is classified or rolled back.
   * 3. **Classification, in declaration order,** so `result.steps[]` and the
   *    rollback registration are deterministic regardless of completion
   *    order: completed steps join the rollback list (their reverse walk thus
   *    undoes the group in reverse declaration order before prior entries),
   *    failed steps become failures (`result.error` is the first), and steps
   *    ended by an abort — in flight, or still queued and therefore never
   *    dispatched — are `'skipped'`: `'cancelled'` if the pipeline was
   *    cancelled, `'cancelled (parallel peer failed)'` if the group was.
   *
   * A pipeline-level cancel observed during the group takes precedence over
   * coincident step failures (matching the sequential executor): the run is
   * reported as aborted with the abort reason as `result.error`, though any
   * genuinely failed steps keep their `'failed'` reports.
   */
  private async executeParallelEntry(
    groupSteps: Step<TContext>[],
    concurrency: number | undefined,
    ctx: TContext,
    steps: StepReport[],
    completed: Completed<TContext>[],
    logger: Logger,
    trace: TraceScope,
  ): Promise<EntryOutcome<TContext>> {
    const pipelineSignal = ctx.signal;

    // -- Phase 1: sequential guard evaluation (section 1.1.2, point 1). --
    const dispositions: ('run' | 'skip')[] = [];
    for (const step of groupSteps) {
      let shouldRun = true;
      if (step.guard) {
        const guardStart = performance.now();
        try {
          shouldRun = await step.guard(ctx);
        } catch (raw) {
          for (let i = 0; i < dispositions.length; i++) {
            if (dispositions[i] === 'skip') {
              this.traceReportedStep(
                trace,
                this.pushGuardSkip(groupSteps[i]!, steps, logger),
              );
            }
          }
          const failure = this.recordFailure(
            ctx,
            step,
            raw,
            performance.now() - guardStart,
            steps,
            logger,
          );
          // A group step is only given a span at dispatch, so the one step
          // that got as far as a throwing guard needs its span emitted here.
          this.traceReportedStep(trace, failure.report);
          return { status: 'failed', failures: [failure] };
        }
      }
      dispositions.push(shouldRun ? 'run' : 'skip');
    }

    // -- Phase 2: concurrent execution (section 1.1.2, point 2). --
    const slots = new Map<number, ParallelSlot>();
    const runnable: { step: Step<TContext>; index: number }[] = [];
    for (let i = 0; i < groupSteps.length; i++) {
      if (dispositions[i] === 'run') {
        runnable.push({ step: groupSteps[i]!, index: i });
      }
    }
    if (runnable.length > 0) {
      // Two levels of cancellation (section 1.1.3): a failing peer aborts the
      // group controller, while an external cancel arrives via the pipeline
      // signal; every step in the group observes both.
      const group = new AbortController();
      const groupSignal = AbortSignal.any([group.signal, pipelineSignal]);
      // The group signal is never put on the shared ctx: concurrent steps
      // share one context, so each step observes its own cancellation through
      // its own `meta.signal`, derived from this group signal per attempt
      // (0.4.0 spec, section 1.3). `ctx.signal` stays the pipeline signal.
      const tasks: Promise<void>[] = [];
      // The bounded pool (section 1.5): dispatching stays sequential and in
      // declaration order, but at most `limit` runs are in flight at once, a
      // queued step being dispatched as soon as a slot frees. Omitting the
      // option — or setting it at or above the group size — makes `inFlight`
      // never reach the limit, so the loop below never waits and behaves
      // exactly as 0.3.0 did.
      const limit = concurrency ?? runnable.length;
      const inFlight = new Set<Promise<void>>();
      // A step whose idempotency key fails to resolve (section 1.4) fails
      // before it ever runs. Aborting the group there and then would hand
      // every peer dispatched afterwards in the same burst an already-aborted
      // signal — which fires no `abort` event, stranding a cooperative run
      // that waits for one. So key failures are collected and the group is
      // aborted once every other step is in flight with a live signal: at the
      // first point the pool would have to wait, or after the final dispatch.
      let keyFailure: StepError | undefined;
      for (const { step, index } of runnable) {
        if (inFlight.size >= limit) {
          if (keyFailure !== undefined) {
            // Every peer is in flight, so aborting is safe now — and this
            // step, still queued, is simply never dispatched.
            group.abort(keyFailure);
            break;
          }
          await Promise.race(inFlight);
          // A queued step is never dispatched once the group has aborted —
          // a peer failed, or the pipeline was cancelled (section 1.5). It
          // settles into no slot at all and is classified below exactly like
          // an in-flight peer that was cancelled.
          if (groupSignal.aborted) {
            break;
          }
        }
        await this.runHooks(
          this.beforeHooks,
          (hook) => hook(ctx, step),
          'before',
          step.name,
          logger,
        );
        const keyStart = performance.now();
        let idempotencyKey: string;
        try {
          idempotencyKey = resolveIdempotencyKey(step, ctx);
        } catch (raw) {
          const error = new StepError(step.name, { cause: raw });
          const durationMs = performance.now() - keyStart;
          slots.set(index, {
            kind: 'failed',
            error,
            timedOut: false,
            durationMs,
          });
          // The step is never dispatched, so no task will open a span for it.
          this.traceReportedStep(trace, {
            name: step.name,
            status: 'failed',
            durationMs,
            error,
          });
          logger.debug('step failed', {
            stepName: step.name,
            status: 'failed',
            ...describeError(raw),
          });
          // The first failure in declaration order is the group's reason,
          // matching how `result.error` is chosen (section 1.1.3, point 4).
          keyFailure ??= error;
          continue;
        }
        const task = this.runParallelStep(
          step,
          index,
          ctx,
          groupSignal,
          group,
          slots,
          logger,
          idempotencyKey,
          trace,
        );
        tasks.push(task);
        // Occupies a slot until it settles; the handler is registered here, so
        // it has already run by the time a waiting `Promise.race` resolves.
        inFlight.add(task);
        void task.then(() => {
          inFlight.delete(task);
        });
      }
      if (keyFailure !== undefined) {
        group.abort(keyFailure);
      }
      // Wait for every dispatched step to settle — completed, failed, or
      // cancelled — before classification and rollback (section 1.1.3, point 1).
      await Promise.allSettled(tasks);
    }

    // -- Phase 3: classification in declaration order (section 1.1.3, point 2). --
    const failures: Failure<TContext>[] = [];
    for (let i = 0; i < groupSteps.length; i++) {
      const step = groupSteps[i]!;
      if (dispositions[i] === 'skip') {
        this.traceReportedStep(trace, this.pushGuardSkip(step, steps, logger));
        continue;
      }
      // Every dispatched step settled into a slot before allSettled resolved.
      // A step still queued when the group aborted has none at all, and is
      // reported exactly like an in-flight peer that was cancelled (section 1.5).
      const slot = slots.get(i);
      if (slot?.kind === 'completed') {
        const report: StepReport = {
          name: step.name,
          status: 'completed',
          durationMs: slot.durationMs,
          attempts: slot.attempts,
          idempotencyKey: slot.idempotencyKey,
        };
        attachInnerResult(ctx, report);
        steps.push(report);
        completed.push({
          step,
          report,
          idempotencyKey: slot.idempotencyKey,
        });
      } else if (slot?.kind === 'failed') {
        const report: StepReport = {
          name: step.name,
          status: 'failed',
          durationMs: slot.durationMs,
          error: slot.error,
        };
        // Absent when the step failed while resolving its idempotency key,
        // before any attempt (section 1.4).
        if (slot.attempts !== undefined) {
          report.attempts = slot.attempts;
        }
        if (slot.idempotencyKey !== undefined) {
          report.idempotencyKey = slot.idempotencyKey;
        }
        if (slot.timedOut) {
          report.timedOut = true;
        }
        attachInnerResult(ctx, report);
        steps.push(report);
        failures.push({ error: slot.error, step, report });
      } else {
        // Ended by an abort — mid-flight, or before it was ever dispatched;
        // the skipReason records which level aborted.
        // A cancelled pipeline-as-step still surfaces its inner Result.
        const report: StepReport = {
          name: step.name,
          status: 'skipped',
          durationMs: 0,
          skipReason: cancelledSkipReason(pipelineSignal),
        };
        attachInnerResult(ctx, report);
        steps.push(report);
        // A dispatched step already closed its own span; one still queued when
        // the group aborted never had one, so it gets a zero-length span here
        // — keeping the trace one-to-one with `result.steps` (section 1.8).
        if (slot === undefined) {
          this.traceReportedStep(trace, report);
        }
        logger.debug('step skipped', {
          stepName: step.name,
          status: 'skipped',
        });
      }
    }

    if (pipelineSignal.aborted) {
      return { status: 'cancelled', reason: pipelineSignal.reason };
    }
    if (failures.length > 0) {
      return { status: 'failed', failures };
    }
    return { status: 'continue' };
  }

  /**
   * Drives one dispatched parallel step to a settled {@link ParallelSlot} and
   * fires its per-step observers. On the first failure in the group it aborts
   * the group controller so in-flight peers that forwarded `ctx.signal` can
   * stop early (section 1.1.3, point 1) — later failures re-abort harmlessly.
   * Never rejects: every path stores a slot, which is what allows the group's
   * `Promise.allSettled` to classify all steps afterwards.
   */
  private async runParallelStep(
    step: Step<TContext>,
    index: number,
    ctx: TContext,
    groupSignal: AbortSignal,
    group: AbortController,
    slots: Map<number, ParallelSlot>,
    logger: Logger,
    idempotencyKey: string,
    trace: TraceScope,
  ): Promise<void> {
    // The span opens at dispatch and closes when this step settles, so a step
    // waiting for a pool slot is not shown as running (0.4.0 spec, sections
    // 1.5 and 1.8). Its outcome is stamped from the same facts phase 3 will
    // put in the report, since the report is not assembled until the whole
    // group has settled.
    const span = trace.tracing.step(step.name, trace.span);
    try {
      recordStepStart(span, step.name);
      recordStepKey(span, idempotencyKey);
      bindStepSpan(ctx, step.name, span);
      const start = performance.now();
      const outcome = await this.executeStepRun(
        step,
        ctx,
        groupSignal,
        'parallel',
        idempotencyKey,
        { tracing: trace.tracing, span },
      );
      const durationMs = performance.now() - start;
      if (outcome.ok) {
        slots.set(index, {
          kind: 'completed',
          attempts: outcome.attempts,
          durationMs,
          idempotencyKey,
        });
        recordStepOutcome(span, {
          status: 'completed',
          durationMs,
          attempts: outcome.attempts,
        });
        logger.debug('step completed', {
          stepName: step.name,
          status: 'completed',
          durationMs,
        });
        await this.runHooks(
          this.afterHooks,
          (hook) => hook(ctx, step, { status: 'completed', durationMs }),
          'after',
          step.name,
          logger,
        );
        return;
      }
      if (outcome.cancelled) {
        slots.set(index, { kind: 'cancelled' });
        recordStepOutcome(span, {
          status: 'skipped',
          durationMs: 0,
          skipReason: cancelledSkipReason(ctx.signal),
        });
        return;
      }
      const error = new StepError(step.name, { cause: outcome.error });
      slots.set(index, {
        kind: 'failed',
        error,
        attempts: outcome.attempts,
        timedOut: outcome.timedOut,
        durationMs,
        idempotencyKey,
      });
      recordStepOutcome(span, {
        status: 'failed',
        durationMs,
        attempts: outcome.attempts,
        timedOut: outcome.timedOut,
        error,
      });
      logger.debug('step failed', {
        stepName: step.name,
        status: 'failed',
        ...describeError(outcome.error),
      });
      group.abort(error);
    } finally {
      unbindStepSpan(ctx, step.name);
      span.end();
    }
  }

  /**
   * Emits the span for a step that produced a report but never had a span of
   * its own: a guard skip, a step a cancelled run never reached, a group step
   * whose guard threw, and a group step still queued when the pool aborted
   * (0.4.0 spec, section 1.8). Every `StepReport` thus has exactly one span.
   */
  private traceReportedStep(trace: TraceScope, report: StepReport): void {
    const span = trace.tracing.step(report.name, trace.span);
    try {
      recordStepStart(span, report.name);
      recordStepOutcome(span, report);
    } finally {
      span.end();
    }
  }

  /**
   * Dry-run planner (section 1.2): planning, not execution — it produces no side
   * effects. It evaluates each step's guard (parallel steps sequentially, in
   * declaration order — 0.3.0 spec, section 1.1.4) and records the ordered
   * plan, marking each step `'would-run'` or `'skipped'` (with `skipReason`),
   * and never calls a `run` or `undo`. A guard that itself throws is treated
   * as a step failure (`'failed'`, `ok:false`) and planning stops there.
   * Hooks are execution observers, so they do not fire while planning.
   */
  private async plan(
    ctx: TContext,
    logger: Logger,
    startedAt: number,
  ): Promise<Result<TContext>> {
    const steps: StepReport[] = [];
    let failure: Failure<TContext> | null = null;

    outer: for (const entry of this.entries) {
      const group = entry.kind === 'sequential' ? [entry.step] : entry.steps;
      for (const step of group) {
        let shouldRun = true;
        if (step.guard) {
          const guardStart = performance.now();
          try {
            shouldRun = await step.guard(ctx);
          } catch (raw) {
            failure = this.recordFailure(
              ctx,
              step,
              raw,
              performance.now() - guardStart,
              steps,
              logger,
            );
            break outer;
          }
        }
        if (!shouldRun) {
          this.pushGuardSkip(step, steps, logger);
          continue;
        }
        steps.push({ name: step.name, status: 'would-run', durationMs: 0 });
        logger.debug('step would run', {
          stepName: step.name,
          status: 'would-run',
        });
      }
    }

    if (failure) {
      return this.buildResult(ctx, steps, startedAt, {
        ok: false,
        error: failure.error,
        rollbackErrors: [],
        aborted: false,
      });
    }
    return this.buildResult(ctx, steps, startedAt, {
      ok: true,
      error: null,
      rollbackErrors: [],
      aborted: false,
    });
  }

  /**
   * Runs a step's `run` under its retry policy (section 1.1). Only `run` is
   * retried — guards and undos never are. For up to `attempts` tries it runs the
   * step (each attempt honouring the per-attempt timeout, section 1.2); on
   * success it returns the attempt count, and on failure it waits the computed
   * backoff delay before trying again, surfacing the final attempt's error (and
   * whether it timed out) once the budget is spent.
   *
   * `baseSignal` is the pipeline signal for a sequential step, or the
   * group-combined signal for a parallel one (0.3.0 spec, section 1.1.3); it is
   * passed to the inter-attempt delay so an abort wakes it early, and it is one
   * input to each attempt's `meta.signal`. An abort surfacing through an attempt
   * or a woken delay yields the `cancelled` outcome rather than a failure —
   * under which conditions depends on `mode` (see {@link RunMode}). A step with
   * no `retry` runs exactly once (`attempts: 1`).
   *
   * `idempotencyKey` was resolved once by the caller, before this loop, and is
   * handed to every attempt unchanged (0.4.0 spec, section 1.4).
   */
  private async executeStepRun(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
    mode: RunMode,
    idempotencyKey: string,
    trace: TraceScope,
  ): Promise<RunOutcome> {
    const retry = step.retry;
    const maxAttempts = retry?.attempts ?? 1;
    for (let attempt = 1; ; attempt++) {
      const result = await this.runTracedAttempt(
        step,
        ctx,
        baseSignal,
        {
          stepName: step.name,
          pipelineName: this.name,
          executionId: ctx.executionId,
          attempt,
          maxAttempts,
          idempotencyKey,
        },
        trace,
      );
      if (result.ok) {
        return { ok: true, attempts: attempt };
      }
      // An abort seen through a failed attempt is a cancellation, not a step
      // failure — stop and roll back (section 1.3) whatever retry budget
      // remains, and never wrap the abort reason in a StepError. Sequentially,
      // any abort qualifies (only an external cancel can abort the base
      // signal, and it takes precedence over a coincident timeout); in a
      // parallel group the base signal also aborts when a *peer* fails, so
      // only a rejection that IS the abort reason (a cooperative run
      // forwarding ctx.signal) counts — a step's own failure racing the group
      // abort stays a failure (0.3.0 spec, section 1.1.3, point 2).
      if (
        baseSignal.aborted &&
        (mode === 'sequential' || result.error === baseSignal.reason)
      ) {
        return { ok: false, cancelled: true };
      }
      // No retry policy, or the budget is spent: surface this final failure.
      // (Testing `retry === undefined` first also narrows it below.)
      if (retry === undefined || attempt >= maxAttempts) {
        return {
          ok: false,
          cancelled: false,
          attempts: attempt,
          error: result.error,
          timedOut: result.timedOut,
        };
      }
      const delayMs = computeRetryDelay(retry, attempt - 1);
      if (delayMs > 0) {
        try {
          await sleep(delayMs, undefined, { signal: baseSignal });
        } catch {
          // `node:timers/promises` setTimeout rejects only when its signal
          // aborts, so a rejection here means the base signal aborted during
          // the retry delay — a pipeline cancel (section 1.3) or, for a
          // parallel step, the group abort after a peer failed. Either way
          // the step is cancelled, not failed.
          return { ok: false, cancelled: true };
        }
      }
    }
  }

  /**
   * Runs one attempt inside its own span (0.4.0 spec, section 1.8). The span
   * exists only when the step actually retries — `Tracing.attempt` returns the
   * inert span for `maxAttempts === 1`, where an attempt span would merely
   * duplicate the step span — and it is closed in a `finally` so a rejection
   * from anywhere below cannot leak it.
   */
  private async runTracedAttempt(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
    meta: Omit<StepMeta, 'signal'>,
    trace: TraceScope,
  ): Promise<AttemptResult> {
    const span = trace.tracing.attempt(
      step.name,
      meta.attempt,
      meta.maxAttempts,
      trace.span,
    );
    try {
      const result = await this.runAttempt(step, ctx, baseSignal, meta);
      recordAttemptOutcome(span, result);
      return result;
    } finally {
      span.end();
    }
  }

  /**
   * Runs a single attempt of a step's `run`, applying its per-attempt timeout
   * (section 1.2) when configured, and handing it this invocation's
   * {@link StepMeta}.
   *
   * `meta.signal` is built **fresh per attempt** as
   * `AbortSignal.any([...])` over the per-attempt timeout (when set) and the
   * base signal — the pipeline signal for a sequential step, the
   * group-combined signal inside a parallel group. Because it is a distinct
   * object per invocation, concurrently running steps each observe their own
   * timeout without disturbing a peer's, which a single shared `ctx.signal`
   * could never express (0.4.0 spec, section 1.3). `ctx.signal` itself is
   * never touched.
   *
   * With a timeout, only the **timeout** races `run`: an abort of the base
   * signal must never interrupt in-flight user code (section 1.3), so it
   * cannot abandon the run — it is honoured between entries (and, for a
   * cooperative `run` watching `meta.signal`, by the run rejecting itself),
   * then classified by {@link Pipeline.executeStepRun}. `timedOut` reflects
   * whether the timeout fired.
   */
  private async runAttempt(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
    meta: Omit<StepMeta, 'signal'>,
  ): Promise<AttemptResult> {
    const timeoutSignal =
      step.timeout === undefined
        ? undefined
        : AbortSignal.timeout(step.timeout);
    const signal =
      timeoutSignal === undefined
        ? AbortSignal.any([baseSignal])
        : AbortSignal.any([timeoutSignal, baseSignal]);
    const stepMeta: StepMeta = { ...meta, signal };
    if (timeoutSignal === undefined) {
      try {
        await step.run(ctx, stepMeta);
        return { ok: true };
      } catch (error) {
        return { ok: false, error, timedOut: false };
      }
    }
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener(
          'abort',
          () => reject(timeoutSignal.reason),
          { once: true },
        );
      });
      await Promise.race([
        Promise.resolve(step.run(ctx, stepMeta)),
        timeoutPromise,
      ]);
      return { ok: true };
    } catch (error) {
      // The per-attempt timeout firing is what defines a timeout, regardless of
      // which racer rejected first.
      return { ok: false, error, timedOut: timeoutSignal.aborted };
    }
  }

  /**
   * Records a step failure: wraps the raw thrown value in a {@link StepError}
   * (preserving it as `.cause`, section 3.8), pushes a `'failed'` report (section 3.4), logs
   * the lifecycle at `debug` with names/types only (section 1.10), and returns the
   * failure so `execute` can fire `onError` and roll back. `run` details are
   * recorded only when the failure came from a step's `run`: its attempt count,
   * the idempotency key it was invoked under (0.4.0 spec, section 1.4), and
   * whether its per-attempt timeout fired (section 1.2). A failure raised before
   * the run — a throwing guard, or a throwing idempotency-key function — leaves
   * all three unset. A pipeline-as-step failure additionally carries the inner
   * pipeline's `Result` as `innerResult` (0.3.0 spec, section 1.2.5).
   */
  private recordFailure(
    ctx: TContext,
    step: Step<TContext>,
    raw: unknown,
    durationMs: number,
    steps: StepReport[],
    logger: Logger,
    run?: { attempts: number; timedOut: boolean; idempotencyKey: string },
  ): Failure<TContext> {
    const error = new StepError(step.name, { cause: raw });
    const report: StepReport = {
      name: step.name,
      status: 'failed',
      durationMs,
      error,
    };
    if (run !== undefined) {
      report.attempts = run.attempts;
      report.idempotencyKey = run.idempotencyKey;
      if (run.timedOut) {
        report.timedOut = true;
      }
    }
    attachInnerResult(ctx, report);
    steps.push(report);
    logger.debug('step failed', {
      stepName: step.name,
      status: 'failed',
      ...describeError(raw),
    });
    return { error, step, report };
  }

  /**
   * Pushes the `'skipped'` report for a step whose guard returned false, and
   * returns it so the caller can stamp the step's span from it (section 1.8).
   */
  private pushGuardSkip(
    step: Step<TContext>,
    steps: StepReport[],
    logger: Logger,
  ): StepReport {
    const report: StepReport = {
      name: step.name,
      status: 'skipped',
      durationMs: 0,
      skipReason: 'guard returned false',
    };
    steps.push(report);
    logger.debug('step skipped', {
      stepName: step.name,
      status: 'skipped',
    });
    return report;
  }

  /**
   * Records the steps cancelled by a pipeline cancellation (section 1.3):
   * every step of `this.entries[fromEntry..]` — expanding parallel groups —
   * is pushed as `'skipped'` with `skipReason: 'cancelled'`. These steps never
   * completed, so there is nothing to compensate for them; completed steps
   * roll back separately. An entry that observed the cancel itself reports its
   * own steps first and is excluded by the caller passing the next index.
   */
  private markCancelled(
    fromEntry: number,
    steps: StepReport[],
    logger: Logger,
    trace: TraceScope,
  ): void {
    for (let i = fromEntry; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const group = entry.kind === 'sequential' ? [entry.step] : entry.steps;
      for (const step of group) {
        const report: StepReport = {
          name: step.name,
          status: 'skipped',
          durationMs: 0,
          skipReason: 'cancelled',
        };
        steps.push(report);
        this.traceReportedStep(trace, report);
        logger.debug('step skipped', {
          stepName: step.name,
          status: 'skipped',
        });
      }
    }
  }

  /**
   * Best-effort, reverse-order compensation (section 1.7). Walks completed steps
   * newest-first — parallel steps were registered in declaration order when
   * their group settled, so a group is undone in reverse declaration order
   * before the entries that preceded it (0.3.0 spec, section 1.1.3, point 3) —
   * and runs each `undo` if present. A successful undo flips the report to
   * `'rolled-back'`; a throwing undo flips it to `'rollback-failed'`, collects
   * the error (logged at `error`), and — crucially — does **not** abort the
   * remaining undos, since compensations are independent. Completed steps with
   * no `undo` declare themselves to need none and stay `'completed'`. Returns
   * the collected undo failures (possibly empty).
   *
   * Each `undo` receives its own {@link StepMeta} (0.4.0 spec, section 1.2):
   * `attempt` and `maxAttempts` are `1` because compensations are never
   * retried, the key is the run key plus `:undo`, and the signal is the
   * pipeline signal — a compensation must be allowed to finish, so it is not
   * bound by the step's per-attempt timeout.
   */
  private async rollback(
    completed: Completed<TContext>[],
    ctx: TContext,
    logger: Logger,
    trace: TraceScope,
  ): Promise<Error[]> {
    const rollbackErrors: Error[] = [];
    for (let i = completed.length - 1; i >= 0; i--) {
      const { step, report, idempotencyKey } = completed[i]!;
      if (!step.undo) {
        continue;
      }
      // One compensation span per `undo` actually run, hung off the pipeline
      // span rather than the step's — the step's span closed long ago, and a
      // compensation belongs to the rollback phase (0.4.0 spec, section 1.8).
      const span = trace.tracing.undo(step.name, trace.span);
      try {
        recordUndoStart(span, step.name);
        try {
          await step.undo(ctx, {
            stepName: step.name,
            pipelineName: this.name,
            executionId: ctx.executionId,
            attempt: 1,
            maxAttempts: 1,
            idempotencyKey: `${idempotencyKey}:undo`,
            signal: ctx.signal,
          });
          report.status = 'rolled-back';
          recordUndoOutcome(span, report.status);
          logger.debug('step rolled back', {
            stepName: step.name,
            status: 'rolled-back',
          });
        } catch (raw) {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          report.status = 'rollback-failed';
          report.error = error;
          rollbackErrors.push(error);
          recordUndoOutcome(span, report.status, error);
          logger.error('step rollback failed', {
            stepName: step.name,
            status: 'rollback-failed',
            ...describeError(raw),
          });
        }
      } finally {
        span.end();
      }
    }
    return rollbackErrors;
  }

  /**
   * Builds the {@link PipelineError} thrown under `{ throwOnError: true }`
   * (section 1.7): its `.cause` is the originating step failure (`=== result.error`),
   * and when any `undo` failed its `.rollbackErrors` is a native `AggregateError`
   * bundling them.
   */
  private toPipelineError(result: Result<TContext>): PipelineError<TContext> {
    const rollbackErrors =
      result.rollbackErrors.length > 0
        ? new AggregateError(
            result.rollbackErrors,
            `Pipeline "${this.name}" rollback failed`,
          )
        : undefined;
    return new PipelineError<TContext>(`Pipeline "${this.name}" failed`, {
      result,
      cause: result.error,
      rollbackErrors,
    });
  }

  /**
   * Fires the lifecycle callbacks for a finished run (0.3.0 spec, section
   * 1.3): the one outcome family — `onComplete` for success, `onCancel` for a
   * signal-aborted run, `onFailure` for a step failure (`result.aborted` is
   * what separates those two) — then, always, `onSettled`, last. By the time
   * this runs, rollback has already completed; under `throwOnError` the
   * callbacks fire before the `PipelineError` is thrown, so observers always
   * see the settled `Result`. Dry-run returns from `plan` earlier and fires
   * nothing.
   */
  private async fireLifecycle(
    result: Result<TContext>,
    logger: Logger,
  ): Promise<void> {
    if (result.ok) {
      await this.fireLifecycleCallbacks(
        this.completeCallbacks,
        result,
        'onComplete',
        logger,
      );
    } else if (result.aborted) {
      await this.fireLifecycleCallbacks(
        this.cancelCallbacks,
        result,
        'onCancel',
        logger,
      );
    } else {
      await this.fireLifecycleCallbacks(
        this.failureCallbacks,
        result,
        'onFailure',
        logger,
      );
    }
    await this.fireLifecycleCallbacks(
      this.settledCallbacks,
      result,
      'onSettled',
      logger,
    );
  }

  /**
   * Runs one family of lifecycle callbacks in registration order, each
   * awaited. Lifecycle callbacks are observers with the same containment as
   * hooks (section 1.8): a throw or rejection is caught, logged at `warn` —
   * carrying only the callback kind and the error's type/message (section
   * 1.10) — and never alters the `Result` or stops the remaining callbacks.
   */
  private async fireLifecycleCallbacks(
    callbacks: readonly LifecycleCallback<TContext>[],
    result: Result<TContext>,
    kind: string,
    logger: Logger,
  ): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback(result);
      } catch (err) {
        logger.warn('lifecycle callback threw', {
          callback: kind,
          ...describeError(err),
        });
      }
    }
  }

  /**
   * Runs observer hooks in registration order. Hooks are observers (section 1.8): a
   * throw or rejection is caught and never alters flow. A `before`/`after` throw
   * is logged at `warn`, an `onError` throw at `error`. The log carries only
   * names and the error's type/message — no payloads (section 1.10).
   */
  private async runHooks<H>(
    hooks: readonly H[],
    invoke: (hook: H) => void | Promise<void>,
    kind: string,
    stepName: string,
    logger: Logger,
  ): Promise<void> {
    const level: 'warn' | 'error' = kind === 'onError' ? 'error' : 'warn';
    for (const hook of hooks) {
      try {
        await invoke(hook);
      } catch (err) {
        logger[level]('hook threw', {
          hook: kind,
          stepName,
          ...describeError(err),
        });
      }
    }
  }
}

/**
 * Resolves the idempotency key for one step invocation (0.4.0 spec, section
 * 1.4). Called **once, before the first attempt**, and the result reused for
 * every retry — a key that changed between attempts would tell the downstream
 * service each retry is a new operation, which is exactly what the key exists
 * to prevent.
 *
 * A configured string is used verbatim; a configured function is evaluated with
 * the run context, so keys can derive from business data. Otherwise the default
 * is `` `${executionId}:${stepName}` ``, unique per execution and per step. A
 * throwing key function propagates to the caller, which records it as a step
 * failure (it depends on runtime context, so it is not misuse).
 */
function resolveIdempotencyKey<TContext extends BaseContext>(
  step: Step<TContext>,
  ctx: TContext,
): string {
  const configured = step.idempotencyKey;
  if (typeof configured === 'string') {
    return configured;
  }
  if (typeof configured === 'function') {
    return configured(ctx);
  }
  return `${ctx.executionId}:${step.name}`;
}

/**
 * Per-run registry of the inner `Result`s produced by pipeline-as-step runs
 * (0.3.0 spec, section 1.2.5), keyed by the outer run's context and then by
 * wrapping-step name. Keying by the per-`execute` context keeps it
 * re-entrancy-safe (concurrent runs of one pipeline never share a map) and
 * name-keying inside keeps concurrent parallel wrapping steps apart; the
 * `WeakMap` ties each entry's lifetime to its run. The executor consumes an
 * entry into `StepReport.innerResult` when it builds the wrapping step's
 * terminal report; a retried wrapping step overwrites its entry per attempt,
 * so the final attempt's inner Result is the one that surfaces. `Step` itself
 * is never mutated.
 */
// Matches the intentionally erased inner context type of StepReport.innerResult.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const innerResults = new WeakMap<BaseContext, Map<string, Result<any>>>();

/** Records the inner Result a pipeline-as-step run just produced. */
function storeInnerResult(
  ctx: BaseContext,
  stepName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
  result: Result<any>,
): void {
  let map = innerResults.get(ctx);
  if (map === undefined) {
    map = new Map();
    innerResults.set(ctx, map);
  }
  map.set(stepName, result);
}

/**
 * Moves a stored inner Result, if any, onto the step's terminal report as
 * `innerResult`. A no-op for every step that is not a pipeline-as-step (or
 * whose inner pipeline never ran — e.g. a guard skip or a throwing mapInput).
 */
function attachInnerResult(ctx: BaseContext, report: StepReport): void {
  const map = innerResults.get(ctx);
  const inner = map?.get(report.name);
  if (inner !== undefined) {
    map?.delete(report.name);
    report.innerResult = inner;
  }
}

/**
 * Computes the delay before the next retry attempt (section 1.1). `attemptIndex`
 * is zero-based for the upcoming wait (0 for the gap after the first try), so
 * `'fixed'` keeps every delay at `delayMs` and `'exponential'` doubles it:
 * `delayMs * 2^attemptIndex`. With `jitter`, a uniform random fraction of the
 * delay is added (range `[delay, 2 * delay)`) to avoid thundering-herd retries.
 */
function computeRetryDelay(retry: RetryOptions, attemptIndex: number): number {
  const base = retry.delayMs ?? 0;
  const delay =
    retry.backoff === 'exponential' ? base * 2 ** attemptIndex : base;
  return retry.jitter ? delay + Math.random() * delay : delay;
}

/**
 * Which level of cancellation ended a parallel step — the pipeline signal, or
 * the group controller after a peer failed (0.3.0 spec, section 1.1.3; 0.4.0
 * spec, section 1.5). Shared so a step's span and its report can never
 * disagree about why it stopped.
 */
function cancelledSkipReason(pipelineSignal: AbortSignal): string {
  return pipelineSignal.aborted
    ? 'cancelled'
    : 'cancelled (parallel peer failed)';
}

/**
 * Per-run tracing handles for pipeline-as-step nesting (0.4.0 spec, section
 * 1.8), keyed by the outer run's context and then by wrapping-step name — the
 * same shape and lifetime as {@link innerResults}, and for the same reasons:
 * one context per `execute` keeps it re-entrancy-safe, and name-keying keeps
 * concurrent wrapping steps inside a parallel group apart. Present only when
 * the run was given a tracer. The stored span is the **user's own** span,
 * because that is what their `tracer.startSpan(name, parent)` expects.
 */
const traceHandles = new WeakMap<
  BaseContext,
  { tracer: Tracer; spans: Map<string, TraceSpan> }
>();

/** Publishes a live step span so a nested pipeline can parent itself to it. */
function bindStepSpan(
  ctx: BaseContext,
  stepName: string,
  span: SafeSpan,
): void {
  const handle = traceHandles.get(ctx);
  if (handle !== undefined && span.raw !== undefined) {
    handle.spans.set(stepName, span.raw);
  }
}

/** Withdraws it again the moment the step settles, so nothing outlives its span. */
function unbindStepSpan(ctx: BaseContext, stepName: string): void {
  traceHandles.get(ctx)?.spans.delete(stepName);
}
