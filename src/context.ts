import type { Logger } from './logger';
import type { EngineAccessor } from './types';

/**
 * The single mutable object threaded by reference through every step of a
 * pipeline run (section 3.3). Users extend it with their own working fields, declared
 * optional since they do not exist until the step that sets them runs.
 */
export interface BaseContext<TInput = unknown> {
  /** The original `execute()` input; never overwritten by the library. */
  readonly input: TInput;
  /** Resolver for engines invoked by steps via `ctx.engines.<name>`. */
  readonly engines: EngineAccessor;
  /** Logger for this run; defaults to a no-op (section 3.7). */
  readonly logger: Logger;
  /**
   * Cancellation signal for this run (section 1.5): aborts on pipeline
   * cancellation or step timeout. Always present so steps can forward it into
   * their own async work; a never-aborting signal is bound when the caller
   * passes none.
   */
  readonly signal: AbortSignal;
}

/**
 * Builds a fresh context for a single `execute()` call. `input` is pinned as a
 * non-writable own property so neither the library nor a step can overwrite the
 * original payload (section 3.3); the object itself stays extensible so steps can add
 * their own fields. `signal` is the caller's cancellation signal when supplied,
 * otherwise a fresh **never-aborting** signal (an unaborted `AbortController`'s
 * signal) so `ctx.signal` is always present and non-optional (section 1.5).
 */
export function createContext<TInput>(
  input: TInput,
  engines: EngineAccessor,
  logger: Logger,
  signal: AbortSignal = new AbortController().signal,
): BaseContext<TInput> {
  const ctx: BaseContext<TInput> = { input, engines, logger, signal };
  Object.defineProperty(ctx, 'input', {
    value: input,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return ctx;
}
