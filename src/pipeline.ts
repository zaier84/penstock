import { setTimeout as sleep } from 'node:timers/promises';

import type { BaseContext } from './context';
import { createContext } from './context';
import { createEngineAccessor } from './engine';
import type { Engine } from './engine';
import { PipelineError, StepError, UsageError } from './errors';
import { assertSafeName } from './internal';
import type { Logger } from './logger';
import { noopLogger } from './logger';
import { Step } from './step';
import type {
  AfterHook,
  AsStepOptions,
  BeforeHook,
  ErrorHook,
  PipelineEntry,
  Result,
  RetryOptions,
  StepOptions,
  StepReport,
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
   * Pipeline-level cancellation signal (section 1.3). It is threaded onto
   * `ctx.signal` so steps can forward it into their own async work, and it is
   * checked between entries — an aborted signal stops the pipeline, skips the
   * remaining steps as `'cancelled'`, and rolls back completed ones.
   */
  signal?: AbortSignal;
}

/** The originating failure captured when a step's `guard` or `run` throws. */
interface Failure<TContext extends BaseContext> {
  error: StepError;
  step: Step<TContext>;
}

/** A completed step paired with its report, so rollback can update it in place. */
interface Completed<TContext extends BaseContext> {
  step: Step<TContext>;
  report: StepReport;
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
 * Settled state of one launched parallel step, keyed by its position in the
 * group. Filled as each task settles (completion order), then read back in
 * declaration order after `Promise.allSettled` so reports and rollback stay
 * deterministic (0.3.0 spec, sections 1.1.3 and 1.1.5).
 */
type ParallelSlot =
  | { kind: 'completed'; attempts: number; durationMs: number }
  | {
      kind: 'failed';
      error: StepError;
      attempts: number;
      timedOut: boolean;
      durationMs: number;
    }
  | { kind: 'cancelled' };

/**
 * How {@link Pipeline.executeStepRun} is being driven, which decides two
 * behaviours that must differ between the executors:
 *
 * - `'sequential'` — the step owns the run exclusively: a timed attempt swaps
 *   `ctx.signal` to a per-attempt combined signal (section 1.2), and *any*
 *   abort of the base signal seen through a failed attempt is a pipeline
 *   cancellation (section 1.3) — nothing else can abort it.
 * - `'parallel'` — concurrent steps share one `ctx`, so `ctx.signal` stays the
 *   group-combined signal for the whole group (never swapped per attempt), and
 *   the base signal also aborts when a *peer* fails (0.3.0 spec, section
 *   1.1.3). A failed attempt is then classified as cancelled only when the
 *   rejection *is* the abort reason (a cooperative run forwarding
 *   `ctx.signal`); a step's own genuine failure that merely races the group
 *   abort stays a failure.
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
   */
  addParallel(steps: Step<TContext>[]): this {
    if (!Array.isArray(steps) || steps.length < 2) {
      throw new UsageError(
        `Pipeline "${this.name}" addParallel requires at least 2 steps`,
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
    this.entries.push({ kind: 'parallel', steps: [...steps] });
    return this;
  }

  /**
   * Wraps this whole pipeline as a single `Step` of an outer pipeline (0.3.0
   * spec, section 1.2). The returned step is a **regular `Step`** — usable
   * with `.when()`, `addStep`, or inside `addParallel` — whose `run`:
   *
   * 1. derives the inner input via `mapInput(outerCtx)`;
   * 2. executes this pipeline on its **own fresh, isolated context**, with
   *    the outer run's logger and the outer `ctx.signal` (so an outer cancel
   *    — or, inside a parallel group, a peer failure — propagates into the
   *    inner run), resolving engines from this pipeline's own `useEngine`
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
    const run = async (outerCtx: TOuterContext): Promise<void> => {
      const innerInput = options.mapInput(outerCtx);
      const innerResult = await this.execute(innerInput, {
        logger: outerCtx.logger,
        signal: outerCtx.signal,
      });
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
      // Planning, not execution (section 1.2): no run/undo, no hooks, no rollback.
      return this.plan(ctx, logger);
    }
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
        this.markCancelled(i, steps, logger);
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
        );
      } else {
        outcome = await this.executeParallelEntry(
          entry.steps,
          ctx,
          steps,
          completed,
          logger,
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
        this.markCancelled(i + 1, steps, logger);
        break;
      }
    }

    if (cancellation) {
      // Cancellation rolls back completed steps exactly like a failure (section
      // 1.3) but fires no `onError`: there is no originating step failure, and
      // the pre-aborted case has no step to hand the hook. The abort reason is
      // surfaced unwrapped as `result.error` (and `PipelineError.cause` under
      // `throwOnError`) — not wrapped in a StepError.
      const rollbackErrors = await this.rollback(completed, ctx, logger);
      const result: Result<TContext> = {
        ok: false,
        context: ctx,
        steps,
        error: cancellation.reason,
        rollbackErrors,
        aborted: true,
      };
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
      const rollbackErrors = await this.rollback(completed, ctx, logger);
      const result: Result<TContext> = {
        ok: false,
        context: ctx,
        steps,
        error: failures[0]!.error,
        rollbackErrors,
        aborted: false,
      };
      if (options.throwOnError) {
        throw this.toPipelineError(result);
      }
      return result;
    }

    return {
      ok: true,
      context: ctx,
      steps,
      error: null,
      rollbackErrors: [],
      aborted: false,
    };
  }

  /**
   * Executes one sequential step: guard, `before` hooks, the run under its
   * retry/timeout policy, then the report and `after` hooks. A throwing guard
   * is a step failure — the guard is the only flow-control mechanism (section
   * 1.8) and is evaluated before any hook. A cancellation surfacing through
   * the run (a woken retry delay or a cooperative run, section 1.3) records
   * the step as `'cancelled'` and stops the pipeline.
   */
  private async executeSequentialEntry(
    step: Step<TContext>,
    ctx: TContext,
    steps: StepReport[],
    completed: Completed<TContext>[],
    logger: Logger,
  ): Promise<EntryOutcome<TContext>> {
    let shouldRun = true;
    if (step.guard) {
      const guardStart = performance.now();
      try {
        shouldRun = await step.guard(ctx);
      } catch (raw) {
        return {
          status: 'failed',
          failures: [
            this.recordFailure(
              ctx,
              step,
              raw,
              performance.now() - guardStart,
              steps,
              logger,
            ),
          ],
        };
      }
    }
    if (!shouldRun) {
      this.pushGuardSkip(step, steps, logger);
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
    // Run with the step's retry policy (section 1.1); only `run` is retried.
    const outcome = await this.executeStepRun(
      step,
      ctx,
      ctx.signal,
      'sequential',
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
        logger.debug('step skipped', {
          stepName: step.name,
          status: 'skipped',
        });
        return { status: 'cancelled', reason: ctx.signal.reason };
      }
      return {
        status: 'failed',
        failures: [
          this.recordFailure(
            ctx,
            step,
            outcome.error,
            durationMs,
            steps,
            logger,
            outcome.attempts,
            outcome.timedOut,
          ),
        ],
      };
    }

    // Keep the report by reference so rollback can flip its status in place.
    const report: StepReport = {
      name: step.name,
      status: 'completed',
      durationMs,
      attempts: outcome.attempts,
    };
    attachInnerResult(ctx, report);
    steps.push(report);
    completed.push({ step, report });
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
   * 2. **Concurrent execution** of the cleared steps. Every step's runs are
   *    driven by a signal combining two cancellation levels: a group-scoped
   *    `AbortController` (aborted as soon as any peer fails) and the pipeline
   *    signal (external cancellation). `before` hooks fire per step at launch
   *    (declaration order — launching is sequential; only the runs overlap);
   *    `after` hooks fire per step as it completes (completion order).
   *    `Promise.allSettled` — never `Promise.all` — waits for every step to
   *    settle before anything is classified or rolled back.
   * 3. **Classification, in declaration order,** so `result.steps[]` and the
   *    rollback registration are deterministic regardless of completion
   *    order: completed steps join the rollback list (their reverse walk thus
   *    undoes the group in reverse declaration order before prior entries),
   *    failed steps become failures (`result.error` is the first), and steps
   *    ended by an abort are `'skipped'` — `'cancelled'` if the pipeline was
   *    cancelled, `'cancelled (parallel peer failed)'` if the group was.
   *
   * A pipeline-level cancel observed during the group takes precedence over
   * coincident step failures (matching the sequential executor): the run is
   * reported as aborted with the abort reason as `result.error`, though any
   * genuinely failed steps keep their `'failed'` reports.
   */
  private async executeParallelEntry(
    groupSteps: Step<TContext>[],
    ctx: TContext,
    steps: StepReport[],
    completed: Completed<TContext>[],
    logger: Logger,
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
              this.pushGuardSkip(groupSteps[i]!, steps, logger);
            }
          }
          return {
            status: 'failed',
            failures: [
              this.recordFailure(
                ctx,
                step,
                raw,
                performance.now() - guardStart,
                steps,
                logger,
              ),
            ],
          };
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
      // Concurrent steps share the one mutable ctx, so ctx.signal is pinned to
      // the group-combined signal for the whole group instead of the
      // per-attempt timeout swap sequential steps get — concurrent swaps of a
      // shared property would race. Timeouts still enforce via the per-attempt
      // race inside runAttempt.
      setContextSignal(ctx, groupSignal);
      try {
        const tasks: Promise<void>[] = [];
        for (const { step, index } of runnable) {
          await this.runHooks(
            this.beforeHooks,
            (hook) => hook(ctx, step),
            'before',
            step.name,
            logger,
          );
          tasks.push(
            this.runParallelStep(
              step,
              index,
              ctx,
              groupSignal,
              group,
              slots,
              logger,
            ),
          );
        }
        // Wait for every step to settle — completed, failed, or cancelled —
        // before classification and rollback (section 1.1.3, point 1).
        await Promise.allSettled(tasks);
      } finally {
        setContextSignal(ctx, pipelineSignal);
      }
    }

    // -- Phase 3: classification in declaration order (section 1.1.3, point 2). --
    const failures: Failure<TContext>[] = [];
    for (let i = 0; i < groupSteps.length; i++) {
      const step = groupSteps[i]!;
      if (dispositions[i] === 'skip') {
        this.pushGuardSkip(step, steps, logger);
        continue;
      }
      // Every launched step settled into a slot before allSettled resolved.
      const slot = slots.get(i)!;
      if (slot.kind === 'completed') {
        const report: StepReport = {
          name: step.name,
          status: 'completed',
          durationMs: slot.durationMs,
          attempts: slot.attempts,
        };
        attachInnerResult(ctx, report);
        steps.push(report);
        completed.push({ step, report });
      } else if (slot.kind === 'failed') {
        const report: StepReport = {
          name: step.name,
          status: 'failed',
          durationMs: slot.durationMs,
          error: slot.error,
          attempts: slot.attempts,
        };
        if (slot.timedOut) {
          report.timedOut = true;
        }
        attachInnerResult(ctx, report);
        steps.push(report);
        failures.push({ error: slot.error, step });
      } else {
        // Ended by an abort mid-flight; the skipReason records which level.
        // A cancelled pipeline-as-step still surfaces its inner Result.
        const report: StepReport = {
          name: step.name,
          status: 'skipped',
          durationMs: 0,
          skipReason: pipelineSignal.aborted
            ? 'cancelled'
            : 'cancelled (parallel peer failed)',
        };
        attachInnerResult(ctx, report);
        steps.push(report);
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
   * Drives one launched parallel step to a settled {@link ParallelSlot} and
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
  ): Promise<void> {
    const start = performance.now();
    const outcome = await this.executeStepRun(
      step,
      ctx,
      groupSignal,
      'parallel',
    );
    const durationMs = performance.now() - start;
    if (outcome.ok) {
      slots.set(index, {
        kind: 'completed',
        attempts: outcome.attempts,
        durationMs,
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
      return;
    }
    const error = new StepError(step.name, { cause: outcome.error });
    slots.set(index, {
      kind: 'failed',
      error,
      attempts: outcome.attempts,
      timedOut: outcome.timedOut,
      durationMs,
    });
    logger.debug('step failed', {
      stepName: step.name,
      status: 'failed',
      ...describeError(outcome.error),
    });
    group.abort(error);
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
  private async plan(ctx: TContext, logger: Logger): Promise<Result<TContext>> {
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
      return {
        ok: false,
        context: ctx,
        steps,
        error: failure.error,
        rollbackErrors: [],
        aborted: false,
      };
    }
    return {
      ok: true,
      context: ctx,
      steps,
      error: null,
      rollbackErrors: [],
      aborted: false,
    };
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
   * passed to the inter-attempt delay so an abort wakes it early. An abort
   * surfacing through an attempt or a woken delay yields the `cancelled`
   * outcome rather than a failure — under which conditions depends on `mode`
   * (see {@link RunMode}). A step with no `retry` runs exactly once
   * (`attempts: 1`).
   */
  private async executeStepRun(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
    mode: RunMode,
  ): Promise<RunOutcome> {
    const retry = step.retry;
    const maxAttempts = retry?.attempts ?? 1;
    for (let attempt = 1; ; attempt++) {
      const result = await this.runAttempt(step, ctx, baseSignal, mode);
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
   * Runs a single attempt of a step's `run`, applying its per-attempt timeout
   * (section 1.2) when configured. With no timeout, `run` is awaited directly
   * and `ctx.signal` is left alone. With a timeout, only the **timeout** races
   * `run`: an abort of the base signal must never interrupt in-flight user
   * code (section 1.3), so it cannot abandon the run — it is honoured between
   * entries (and, for a cooperative `run`, by the run rejecting itself), then
   * classified by {@link Pipeline.executeStepRun}.
   *
   * Sequentially, `ctx.signal` is swapped to a fresh per-attempt
   * `AbortSignal.any([AbortSignal.timeout(t), baseSignal])` so a cooperative
   * `run` can self-abort on either the timeout or a cancel, and restored to
   * the base signal afterwards. In a parallel group `ctx.signal` is shared by
   * concurrent steps and stays the group-combined signal (see
   * {@link RunMode}), so the timeout is enforced by the race alone.
   * `timedOut` reflects whether the timeout fired.
   */
  private async runAttempt(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
    mode: RunMode,
  ): Promise<AttemptResult> {
    if (step.timeout === undefined) {
      try {
        await step.run(ctx);
        return { ok: true };
      } catch (error) {
        return { ok: false, error, timedOut: false };
      }
    }
    const timeoutSignal = AbortSignal.timeout(step.timeout);
    if (mode === 'sequential') {
      setContextSignal(ctx, AbortSignal.any([timeoutSignal, baseSignal]));
    }
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener(
          'abort',
          () => reject(timeoutSignal.reason),
          { once: true },
        );
      });
      await Promise.race([Promise.resolve(step.run(ctx)), timeoutPromise]);
      return { ok: true };
    } catch (error) {
      // The per-attempt timeout firing is what defines a timeout, regardless of
      // which racer rejected first.
      return { ok: false, error, timedOut: timeoutSignal.aborted };
    } finally {
      if (mode === 'sequential') {
        setContextSignal(ctx, baseSignal);
      }
    }
  }

  /**
   * Records a step failure: wraps the raw thrown value in a {@link StepError}
   * (preserving it as `.cause`, section 3.8), pushes a `'failed'` report (section 3.4), logs
   * the lifecycle at `debug` with names/types only (section 1.10), and returns the
   * failure so `execute` can fire `onError` and roll back. `attempts` is recorded
   * when the failure came from a step's `run` (a guard failure leaves it unset,
   * since `run` was never reached); `timedOut` marks a run aborted by its
   * per-attempt timeout (section 1.2). A pipeline-as-step failure additionally
   * carries the inner pipeline's `Result` as `innerResult` (0.3.0 spec,
   * section 1.2.5).
   */
  private recordFailure(
    ctx: TContext,
    step: Step<TContext>,
    raw: unknown,
    durationMs: number,
    steps: StepReport[],
    logger: Logger,
    attempts?: number,
    timedOut?: boolean,
  ): Failure<TContext> {
    const error = new StepError(step.name, { cause: raw });
    const report: StepReport = {
      name: step.name,
      status: 'failed',
      durationMs,
      error,
    };
    if (attempts !== undefined) {
      report.attempts = attempts;
    }
    if (timedOut) {
      report.timedOut = true;
    }
    attachInnerResult(ctx, report);
    steps.push(report);
    logger.debug('step failed', {
      stepName: step.name,
      status: 'failed',
      ...describeError(raw),
    });
    return { error, step };
  }

  /** Pushes the `'skipped'` report for a step whose guard returned false. */
  private pushGuardSkip(
    step: Step<TContext>,
    steps: StepReport[],
    logger: Logger,
  ): void {
    steps.push({
      name: step.name,
      status: 'skipped',
      durationMs: 0,
      skipReason: 'guard returned false',
    });
    logger.debug('step skipped', {
      stepName: step.name,
      status: 'skipped',
    });
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
  ): void {
    for (let i = fromEntry; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const group = entry.kind === 'sequential' ? [entry.step] : entry.steps;
      for (const step of group) {
        steps.push({
          name: step.name,
          status: 'skipped',
          durationMs: 0,
          skipReason: 'cancelled',
        });
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
   */
  private async rollback(
    completed: Completed<TContext>[],
    ctx: TContext,
    logger: Logger,
  ): Promise<Error[]> {
    const rollbackErrors: Error[] = [];
    for (let i = completed.length - 1; i >= 0; i--) {
      const { step, report } = completed[i]!;
      if (!step.undo) {
        continue;
      }
      try {
        await step.undo(ctx);
        report.status = 'rolled-back';
        logger.debug('step rolled back', {
          stepName: step.name,
          status: 'rolled-back',
        });
      } catch (raw) {
        const error = raw instanceof Error ? raw : new Error(String(raw));
        report.status = 'rollback-failed';
        report.error = error;
        rollbackErrors.push(error);
        logger.error('step rollback failed', {
          stepName: step.name,
          status: 'rollback-failed',
          ...describeError(raw),
        });
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
 * Reassigns the run-scoped `signal` on the context. To consumers `ctx.signal` is
 * `readonly` (section 1.5), but the pipeline swaps it to a per-attempt combined
 * timeout/cancellation signal during a sequential timed run (section 1.2), and
 * to the group-combined signal for the duration of a parallel group (0.3.0
 * spec, section 1.1.3), restoring it afterwards. The context is per-`execute`,
 * so this stays re-entrancy-safe.
 */
function setContextSignal(ctx: BaseContext, signal: AbortSignal): void {
  (ctx as { signal: AbortSignal }).signal = signal;
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
 * Reduces a thrown value to a loggable `{ errorType, errorMessage }` — names and
 * types only, never raw payloads or context (section 1.10). Handles non-Error throws.
 */
function describeError(err: unknown): {
  errorType: string;
  errorMessage: string;
} {
  return err instanceof Error
    ? { errorType: err.name, errorMessage: err.message }
    : { errorType: typeof err, errorMessage: String(err) };
}
