import type { Logger } from './logger';
import type { EngineAccessor } from './types';

/**
 * The single mutable object threaded by reference through every step of a
 * pipeline run (§3.3). Users extend it with their own working fields, declared
 * optional since they do not exist until the step that sets them runs.
 */
export interface BaseContext<TInput = unknown> {
  /** The original `execute()` input; never overwritten by the library. */
  readonly input: TInput;
  /** Resolver for engines invoked by steps via `ctx.engines.<name>`. */
  readonly engines: EngineAccessor;
  /** Logger for this run; defaults to a no-op (§3.7). */
  readonly logger: Logger;
}

/**
 * Builds a fresh context for a single `execute()` call. `input` is pinned as a
 * non-writable own property so neither the library nor a step can overwrite the
 * original payload (§3.3); the object itself stays extensible so steps can add
 * their own fields.
 */
export function createContext<TInput>(
  input: TInput,
  engines: EngineAccessor,
  logger: Logger,
): BaseContext<TInput> {
  const ctx: BaseContext<TInput> = { input, engines, logger };
  Object.defineProperty(ctx, 'input', {
    value: input,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return ctx;
}
