import type { BaseContext } from './context';
import { UsageError } from './errors';
import { assertSafeName } from './internal';
import type {
  GuardFn,
  RetryOptions,
  RunFn,
  StepOptions,
  UndoFn,
} from './types';

/**
 * The atomic unit of work in a pipeline (section 3.1): a named `run` function with an
 * optional `when` guard and optional `undo` compensation. A `Step` is immutable
 * and reusable — its config is `readonly` and the fluent {@link Step.when} returns
 * a configured **clone** rather than mutating the original (section 2).
 *
 * The guard is stored as `guard` because the public `.when(fn)` method occupies
 * the `when` name; the constructor maps the `when` option key onto it.
 */
export class Step<TContext extends BaseContext = BaseContext> {
  readonly name: string;
  readonly run: RunFn<TContext>;
  readonly guard?: GuardFn<TContext>;
  readonly undo?: UndoFn<TContext>;
  readonly retry?: RetryOptions;
  readonly timeout?: number;

  constructor(
    name: string,
    fnOrOptions: RunFn<TContext> | StepOptions<TContext>,
  ) {
    assertSafeName('Step', name);
    const options: StepOptions<TContext> =
      typeof fnOrOptions === 'function' ? { run: fnOrOptions } : fnOrOptions;
    if (typeof options.run !== 'function') {
      throw new UsageError(`Step "${name}" must define a "run" function`);
    }
    // Validate retry/timeout synchronously at construction (section 1.7): bad
    // config is misuse, so it fails fast as a UsageError, not as run-time data.
    if (options.retry !== undefined) {
      const { attempts, delayMs } = options.retry;
      if (attempts < 1) {
        throw new UsageError(
          `Step "${name}" retry.attempts must be at least 1`,
        );
      }
      if (delayMs !== undefined && delayMs < 0) {
        throw new UsageError(
          `Step "${name}" retry.delayMs must be greater than or equal to 0`,
        );
      }
    }
    if (options.timeout !== undefined && options.timeout <= 0) {
      throw new UsageError(`Step "${name}" timeout must be greater than 0`);
    }
    this.name = name;
    this.run = options.run;
    // Keep optional config truly absent when not supplied (mirrors PipelineError).
    if (options.when !== undefined) {
      this.guard = options.when;
    }
    if (options.undo !== undefined) {
      this.undo = options.undo;
    }
    if (options.retry !== undefined) {
      this.retry = options.retry;
    }
    if (options.timeout !== undefined) {
      this.timeout = options.timeout;
    }
  }

  /**
   * Returns a **new** `Step` with the guard set, leaving the original untouched.
   * If a guard was already present it is **replaced**, not combined (section 3.1).
   */
  when(fn: GuardFn<TContext>): Step<TContext> {
    return new Step<TContext>(this.name, {
      run: this.run,
      when: fn,
      undo: this.undo,
      retry: this.retry,
      timeout: this.timeout,
    });
  }
}
