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
   * The **pipeline-level** cancellation signal for this run (0.4.0 spec,
   * section 1.3): the caller's `execute(input, { signal })` when supplied,
   * otherwise a never-aborting signal. It is set once when the context is
   * created and never reassigned, so it is safe to read from any step,
   * sequential or parallel.
   *
   * It answers only "was the whole pipeline cancelled". A step's own timeout
   * does **not** abort it — one shared field cannot be the per-attempt timeout
   * signal of several concurrently running steps. Inside a step, prefer
   * `meta.signal`, which combines this signal with that invocation's timeout
   * and its parallel group's signal.
   */
  readonly signal: AbortSignal;
  /**
   * Unique identifier for this `execute()` call (0.4.0 spec, section 1.1),
   * also surfaced as `result.executionId`. It is the correlation id for logs,
   * traces, and idempotency keys.
   */
  readonly executionId: string;
}

/**
 * Builds a fresh context for a single `execute()` call. `input` is pinned as a
 * non-writable own property so neither the library nor a step can overwrite the
 * original payload (section 3.3); the object itself stays extensible so steps can add
 * their own fields. `signal` is the caller's cancellation signal when supplied,
 * otherwise a fresh **never-aborting** signal (an unaborted `AbortController`'s
 * signal) so `ctx.signal` is always present and non-optional; whichever it is, it
 * is bound here once and never reassigned (0.4.0 spec, section 1.3).
 *
 * `executionId` is generated per call with `crypto.randomUUID()` — a Node 20+
 * global, so no new dependency, and no I/O (section 1.10).
 */
export function createContext<TInput>(
  input: TInput,
  engines: EngineAccessor,
  logger: Logger,
  signal: AbortSignal = new AbortController().signal,
): BaseContext<TInput> {
  const ctx: BaseContext<TInput> = {
    input,
    engines,
    logger,
    signal,
    executionId: crypto.randomUUID(),
  };
  Object.defineProperty(ctx, 'input', {
    value: input,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return ctx;
}
