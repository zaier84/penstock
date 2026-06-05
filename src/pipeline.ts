import type { BaseContext } from './context';
import { createContext } from './context';
import { PipelineError, StepError, UsageError } from './errors';
import { assertSafeName } from './internal';
import type { Logger } from './logger';
import { noopLogger } from './logger';
import { Step } from './step';
import type {
  AfterHook,
  BeforeHook,
  EngineAccessor,
  ErrorHook,
  Result,
  StepReport,
} from './types';

/**
 * Options for {@link Pipeline.execute} (§3.2). `logger` and `throwOnError`
 * (§1.7) are honored; `dryRun` (§1.2) is wired in Phase 5.
 */
export interface ExecuteOptions {
  throwOnError?: boolean;
  dryRun?: boolean;
  logger?: Logger;
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
 * An ordered, named collection of steps (§3.2). It threads one context through
 * its steps, evaluates guards, fires observer hooks, runs steps in sequence,
 * and — when a step fails — performs best-effort, reverse-order rollback (§1.7)
 * before returning a structured {@link Result}. The instance holds only
 * immutable config; every piece of per-run state lives in
 * {@link Pipeline.execute}-local variables, so a pipeline is safe to `execute`
 * repeatedly and concurrently (§3.2 re-entrancy).
 *
 * Engines (§3.5) and dry-run (§1.2) arrive in Phase 5.
 */
export class Pipeline<TContext extends BaseContext = BaseContext> {
  readonly name: string;
  private readonly steps: Step<TContext>[] = [];
  // Step-name dedup uses a Set, never a user-keyed plain object (§1.10).
  private readonly stepNames = new Set<string>();
  private readonly beforeHooks: BeforeHook<TContext>[] = [];
  private readonly afterHooks: AfterHook<TContext>[] = [];
  private readonly errorHooks: ErrorHook<TContext>[] = [];

  constructor(name: string) {
    // Empty / non-string / reserved name → UsageError, synchronously (§1.10).
    assertSafeName('Pipeline', name);
    this.name = name;
  }

  /**
   * Appends a step. Throws a `UsageError` synchronously if `step` is not a
   * `Step` or its name duplicates one already in this pipeline (§3.2).
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

  /** Registers a `before` observer hook; multiple are allowed (§3.2). */
  before(hook: BeforeHook<TContext>): this {
    this.beforeHooks.push(hook);
    return this;
  }

  /** Registers an `after` observer hook; multiple are allowed (§3.2). */
  after(hook: AfterHook<TContext>): this {
    this.afterHooks.push(hook);
    return this;
  }

  /** Registers an `onError` observer hook; multiple are allowed (§3.2). */
  onError(hook: ErrorHook<TContext>): this {
    this.errorHooks.push(hook);
    return this;
  }

  /**
   * Builds a fresh context for this call, runs each step in order, and resolves
   * with a {@link Result}. On a step failure the flow aborts, `onError` fires
   * once, completed steps are compensated in reverse order (§1.7), and the
   * `Result` carries `ok:false` with the failure and any rollback errors. With
   * `{ throwOnError: true }` the same failure is thrown as a {@link PipelineError}
   * instead. Per §3.2 all run state is local to this method.
   */
  async execute(
    input: TContext['input'],
    options: ExecuteOptions = {},
  ): Promise<Result<TContext>> {
    const logger = options.logger ?? noopLogger;
    // Phase 5 replaces this placeholder with the real EngineAccessor (§3.5); a
    // null-prototype object keeps it prototype-pollution-safe in the meantime.
    const ctx = createContext(
      input,
      Object.create(null) as EngineAccessor,
      logger,
    ) as TContext;
    const steps: StepReport[] = [];
    // Steps whose `run` completed, in execution order, each with its report.
    // Walked newest-first during rollback (§1.7); local for re-entrancy (§3.2).
    const completed: Completed<TContext>[] = [];
    let failure: Failure<TContext> | null = null;

    for (const step of this.steps) {
      // The guard is the only flow-control mechanism (§1.8); a throwing guard is
      // treated as a step failure (§7 Phase 4). Evaluate it before any hook.
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
      try {
        await step.run(ctx);
      } catch (raw) {
        failure = this.recordFailure(
          step,
          raw,
          performance.now() - start,
          steps,
          logger,
        );
        break;
      }
      const durationMs = performance.now() - start;

      // Keep the report by reference so rollback can flip its status in place.
      const report: StepReport = {
        name: step.name,
        status: 'completed',
        durationMs,
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
      // `onError` fires once, for the originating failure, BEFORE rollback (§1.7).
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
   * Records a step failure: wraps the raw thrown value in a {@link StepError}
   * (preserving it as `.cause`, §3.8), pushes a `'failed'` report (§3.4), logs
   * the lifecycle at `debug` with names/types only (§1.10), and returns the
   * failure so `execute` can fire `onError` and roll back.
   */
  private recordFailure(
    step: Step<TContext>,
    raw: unknown,
    durationMs: number,
    steps: StepReport[],
    logger: Logger,
  ): Failure<TContext> {
    const error = new StepError(step.name, { cause: raw });
    steps.push({ name: step.name, status: 'failed', durationMs, error });
    logger.debug('step failed', {
      stepName: step.name,
      status: 'failed',
      ...describeError(raw),
    });
    return { error, step };
  }

  /**
   * Best-effort, reverse-order compensation (§1.7). Walks completed steps
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
   * (§1.7): its `.cause` is the originating step failure (`=== result.error`),
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
   * Runs observer hooks in registration order. Hooks are observers (§1.8): a
   * throw or rejection is caught and never alters flow. A `before`/`after` throw
   * is logged at `warn`, an `onError` throw at `error`. The log carries only
   * names and the error's type/message — no payloads (§1.10).
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
 * Reduces a thrown value to a loggable `{ errorType, errorMessage }` — names and
 * types only, never raw payloads or context (§1.10). Handles non-Error throws.
 */
function describeError(err: unknown): {
  errorType: string;
  errorMessage: string;
} {
  return err instanceof Error
    ? { errorType: err.name, errorMessage: err.message }
    : { errorType: typeof err, errorMessage: String(err) };
}
