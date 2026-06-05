import type { BaseContext } from './context';
import { createContext } from './context';
import { UsageError } from './errors';
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
 * Options for {@link Pipeline.execute} (§3.2). `logger` is honored now; the
 * `throwOnError` (§1.7) and `dryRun` (§1.2) behaviors are wired in later phases.
 */
export interface ExecuteOptions {
  throwOnError?: boolean;
  dryRun?: boolean;
  logger?: Logger;
}

/**
 * An ordered, named collection of steps (§3.2). It threads one context through
 * its steps, evaluates guards, fires observer hooks, and returns a structured
 * {@link Result}. The instance holds only immutable config — every piece of
 * per-run state lives in {@link Pipeline.execute}-local variables, so a pipeline
 * is safe to `execute` repeatedly and concurrently (§3.2 re-entrancy).
 *
 * Rollback / error capture (§1.7), engines (§3.5), and dry-run (§1.2) arrive in
 * later phases; this is the happy-path execution core with guards and hooks.
 */
export class Pipeline<TContext extends BaseContext = BaseContext> {
  readonly name: string;
  private readonly steps: Step<TContext>[] = [];
  // Step-name dedup uses a Set, never a user-keyed plain object (§1.10).
  private readonly stepNames = new Set<string>();
  private readonly beforeHooks: BeforeHook<TContext>[] = [];
  private readonly afterHooks: AfterHook<TContext>[] = [];
  // Registered now; fired on a step failure, which lands in Phase 4 (§1.7).
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
   * with a {@link Result}. Per §3.2 all run state is local to this method.
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

    for (const step of this.steps) {
      // Evaluate the guard first: a skipped step fires no before/after hook.
      if (step.guard && !(await step.guard(ctx))) {
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
      await step.run(ctx);
      const durationMs = performance.now() - start;

      steps.push({ name: step.name, status: 'completed', durationMs });
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

    return { ok: true, context: ctx, steps, error: null, rollbackErrors: [] };
  }

  /**
   * Runs observer hooks in registration order. Hooks are observers (§1.8): a
   * throw or rejection is caught, logged at `warn`, and never alters flow. The
   * log carries only names and the error's type/message — no payloads (§1.10).
   */
  private async runHooks<H>(
    hooks: readonly H[],
    invoke: (hook: H) => void | Promise<void>,
    kind: string,
    stepName: string,
    logger: Logger,
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await invoke(hook);
      } catch (err) {
        logger.warn('hook threw', {
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
