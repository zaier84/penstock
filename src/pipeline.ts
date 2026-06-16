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
  BeforeHook,
  ErrorHook,
  Result,
  RetryOptions,
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
   * `ctx.signal` so steps can forward it into their own async work; the
   * between-step cancellation check that acts on it arrives in a later phase.
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
 * aborted by its timeout. Both are recorded on the {@link StepReport}.
 */
type RunOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: unknown; timedOut: boolean };

/**
 * Outcome of a single `run` attempt (section 1.2): success, or a failure tagged
 * with whether the per-attempt timeout fired.
 */
type AttemptResult =
  | { ok: true }
  | { ok: false; error: unknown; timedOut: boolean };

/**
 * An ordered, named collection of steps (section 3.2). It threads one context through
 * its steps, evaluates guards, fires observer hooks, runs steps in sequence,
 * and — when a step fails — performs best-effort, reverse-order rollback (section 1.7)
 * before returning a structured {@link Result}. The instance holds only
 * immutable config; every piece of per-run state lives in
 * {@link Pipeline.execute}-local variables, so a pipeline is safe to `execute`
 * repeatedly and concurrently (section 3.2 re-entrancy).
 *
 * Pipeline-scoped engines (section 3.5) shadow the global registry, and `dryRun`
 * planning is available via {@link Pipeline.execute} (section 1.2).
 */
export class Pipeline<TContext extends BaseContext = BaseContext> {
  readonly name: string;
  private readonly steps: Step<TContext>[] = [];
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
   * Appends a step. Throws a `UsageError` synchronously if `step` is not a
   * `Step` or its name duplicates one already in this pipeline (section 3.2).
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
    this.steps.push(step);
    return this;
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
   * Builds a fresh context for this call, runs each step in order, and resolves
   * with a {@link Result}. On a step failure the flow aborts, `onError` fires
   * once, completed steps are compensated in reverse order (section 1.7), and the
   * `Result` carries `ok:false` with the failure and any rollback errors. With
   * `{ throwOnError: true }` the same failure is thrown as a {@link PipelineError}
   * instead. With `{ dryRun: true }` it plans instead of executing (section 1.2). Per
   * section 3.2 all run state is local to this method.
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
    // Steps whose `run` completed, in execution order, each with its report.
    // Walked newest-first during rollback (section 1.7); local for re-entrancy (section 3.2).
    const completed: Completed<TContext>[] = [];
    let failure: Failure<TContext> | null = null;

    for (const step of this.steps) {
      // The guard is the only flow-control mechanism (section 1.8); a throwing guard is
      // treated as a step failure (section 7 Phase 4). Evaluate it before any hook.
      let shouldRun = true;
      if (step.guard) {
        const guardStart = performance.now();
        try {
          shouldRun = await step.guard(ctx);
        } catch (raw) {
          failure = this.recordFailure(
            step,
            raw,
            performance.now() - guardStart,
            steps,
            logger,
          );
          break;
        }
      }
      if (!shouldRun) {
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
        continue;
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
      const outcome = await this.executeStepRun(step, ctx);
      const durationMs = performance.now() - start;
      if (!outcome.ok) {
        failure = this.recordFailure(
          step,
          outcome.error,
          durationMs,
          steps,
          logger,
          outcome.attempts,
          outcome.timedOut,
        );
        break;
      }

      // Keep the report by reference so rollback can flip its status in place.
      const report: StepReport = {
        name: step.name,
        status: 'completed',
        durationMs,
        attempts: outcome.attempts,
      };
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
    }

    if (failure) {
      const { error, step } = failure;
      // `onError` fires once, for the originating failure, BEFORE rollback (section 1.7).
      await this.runHooks(
        this.errorHooks,
        (hook) => hook(error, ctx, step),
        'onError',
        step.name,
        logger,
      );
      const rollbackErrors = await this.rollback(completed, ctx, logger);
      const result: Result<TContext> = {
        ok: false,
        context: ctx,
        steps,
        error,
        rollbackErrors,
      };
      if (options.throwOnError) {
        throw this.toPipelineError(result);
      }
      return result;
    }

    return { ok: true, context: ctx, steps, error: null, rollbackErrors: [] };
  }

  /**
   * Dry-run planner (section 1.2): planning, not execution — it produces no side
   * effects. It evaluates each step's guard and records the ordered plan,
   * marking each step `'would-run'` or `'skipped'` (with `skipReason`), and
   * never calls a `run` or `undo`. A guard that itself throws is treated as a
   * step failure (`'failed'`, `ok:false`) and planning stops there. Hooks are
   * execution observers, so they do not fire while planning.
   */
  private async plan(ctx: TContext, logger: Logger): Promise<Result<TContext>> {
    const steps: StepReport[] = [];
    let failure: Failure<TContext> | null = null;

    for (const step of this.steps) {
      let shouldRun = true;
      if (step.guard) {
        const guardStart = performance.now();
        try {
          shouldRun = await step.guard(ctx);
        } catch (raw) {
          failure = this.recordFailure(
            step,
            raw,
            performance.now() - guardStart,
            steps,
            logger,
          );
          break;
        }
      }
      if (!shouldRun) {
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
        continue;
      }
      steps.push({ name: step.name, status: 'would-run', durationMs: 0 });
      logger.debug('step would run', {
        stepName: step.name,
        status: 'would-run',
      });
    }

    if (failure) {
      return {
        ok: false,
        context: ctx,
        steps,
        error: failure.error,
        rollbackErrors: [],
      };
    }
    return { ok: true, context: ctx, steps, error: null, rollbackErrors: [] };
  }

  /**
   * Runs a step's `run` under its retry policy (section 1.1). Only `run` is
   * retried — guards and undos never are. For up to `attempts` tries it runs the
   * step (each attempt honouring the per-attempt timeout, section 1.2); on
   * success it returns the attempt count, and on failure it waits the computed
   * backoff delay before trying again, surfacing the final attempt's error (and
   * whether it timed out) once the budget is spent. The inter-attempt delay is
   * passed the pipeline signal so a pipeline cancellation can wake it early
   * (section 1.3). A step with no `retry` runs exactly once (`attempts: 1`).
   */
  private async executeStepRun(
    step: Step<TContext>,
    ctx: TContext,
  ): Promise<RunOutcome> {
    const retry = step.retry;
    const maxAttempts = retry?.attempts ?? 1;
    // The pipeline-level signal. `runAttempt` restores it after each attempt, so
    // a per-attempt timeout signal never leaks into the next attempt or the
    // retry delay; every attempt re-combines from this clean base.
    const baseSignal = ctx.signal;
    for (let attempt = 1; ; attempt++) {
      const result = await this.runAttempt(step, ctx, baseSignal);
      if (result.ok) {
        return { ok: true, attempts: attempt };
      }
      // No retry policy, or the budget is spent: surface this final failure.
      // (Testing `retry === undefined` first also narrows it below.)
      if (retry === undefined || attempt >= maxAttempts) {
        return {
          ok: false,
          attempts: attempt,
          error: result.error,
          timedOut: result.timedOut,
        };
      }
      const delayMs = computeRetryDelay(retry, attempt - 1);
      if (delayMs > 0) {
        await sleep(delayMs, undefined, { signal: baseSignal });
      }
    }
  }

  /**
   * Runs a single attempt of a step's `run`, applying its per-attempt timeout
   * (section 1.2) when configured. With no timeout, `run` is awaited directly and
   * `ctx.signal` stays the pipeline signal — existing behaviour, unchanged. With
   * a timeout, a fresh combined signal `AbortSignal.any([AbortSignal.timeout(t),
   * baseSignal])` is exposed as `ctx.signal` (so `run` can observe it) and `run`
   * is raced against it; if the timeout — or a pipeline cancel — fires first, the
   * race rejects with the signal's `reason` (a `TimeoutError` DOMException when
   * the timeout fired). `ctx.signal` is restored to the pipeline signal
   * afterwards. `timedOut` reflects whether the per-attempt timeout fired.
   */
  private async runAttempt(
    step: Step<TContext>,
    ctx: TContext,
    baseSignal: AbortSignal,
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
    const combined = AbortSignal.any([timeoutSignal, baseSignal]);
    setContextSignal(ctx, combined);
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        combined.addEventListener('abort', () => reject(combined.reason), {
          once: true,
        });
      });
      await Promise.race([Promise.resolve(step.run(ctx)), timeoutPromise]);
      return { ok: true };
    } catch (error) {
      // The per-attempt timeout firing is what defines a timeout, regardless of
      // which racer rejected first.
      return { ok: false, error, timedOut: timeoutSignal.aborted };
    } finally {
      setContextSignal(ctx, baseSignal);
    }
  }

  /**
   * Records a step failure: wraps the raw thrown value in a {@link StepError}
   * (preserving it as `.cause`, section 3.8), pushes a `'failed'` report (section 3.4), logs
   * the lifecycle at `debug` with names/types only (section 1.10), and returns the
   * failure so `execute` can fire `onError` and roll back. `attempts` is recorded
   * when the failure came from a step's `run` (a guard failure leaves it unset,
   * since `run` was never reached); `timedOut` marks a run aborted by its
   * per-attempt timeout (section 1.2).
   */
  private recordFailure(
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
    steps.push(report);
    logger.debug('step failed', {
      stepName: step.name,
      status: 'failed',
      ...describeError(raw),
    });
    return { error, step };
  }

  /**
   * Best-effort, reverse-order compensation (section 1.7). Walks completed steps
   * newest-first and runs each `undo` if present. A successful undo flips the
   * report to `'rolled-back'`; a throwing undo flips it to `'rollback-failed'`,
   * collects the error (logged at `error`), and — crucially — does **not** abort
   * the remaining undos, since compensations are independent. Completed steps
   * with no `undo` declare themselves to need none and stay `'completed'`.
   * Returns the collected undo failures (possibly empty).
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
 * timeout/cancellation signal during a timed run (section 1.2) and restores it
 * afterwards. The context is per-`execute`, so this stays re-entrancy-safe.
 */
function setContextSignal(ctx: BaseContext, signal: AbortSignal): void {
  (ctx as { signal: AbortSignal }).signal = signal;
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
