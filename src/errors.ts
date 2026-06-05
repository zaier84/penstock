import type { BaseContext } from './context';
import type { Result } from './types';

/**
 * Base class for every error penstock throws (§3.8). Sets a precise `name`,
 * forwards the native `cause` option, and restores the prototype chain so
 * `instanceof` works even if the class is ever down-leveled below ES2022.
 */
export class PenstockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PenstockError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Synchronous misuse (§1.1): bad construction, a missing `run`, duplicate
 * names, an unknown engine reference, or a reserved/unsafe name (§1.10). Thrown
 * at construction/registration time regardless of `throwOnError`.
 */
export class UsageError extends PenstockError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageError';
  }
}

/**
 * Wraps a step `run` failure (§3.8). Carries the failing step's name and
 * preserves the original error as `.cause`, used to populate `StepReport.error`
 * and `result.error` without leaking raw payloads (§1.10).
 */
export class StepError extends PenstockError {
  readonly stepName: string;

  constructor(stepName: string, options?: ErrorOptions) {
    super(`Step "${stepName}" failed`, options);
    this.name = 'StepError';
    this.stepName = stepName;
  }
}

/**
 * Thrown by `execute` when `{ throwOnError: true }` and the pipeline fails
 * (§1.7). Carries the full `Result`, the originating step failure as `.cause`,
 * and — when any `undo` also failed — those failures bundled as a native
 * `AggregateError` on `.rollbackErrors`.
 */
export class PipelineError<
  TContext extends BaseContext = BaseContext,
> extends PenstockError {
  readonly result: Result<TContext>;
  readonly rollbackErrors?: AggregateError;

  constructor(
    message: string,
    options: {
      result: Result<TContext>;
      cause?: unknown;
      rollbackErrors?: AggregateError;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'PipelineError';
    this.result = options.result;
    if (options.rollbackErrors !== undefined) {
      this.rollbackErrors = options.rollbackErrors;
    }
  }
}
