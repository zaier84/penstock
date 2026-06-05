import type { BaseContext } from './context';

/**
 * The work a `Step` performs: receives the shared context and may mutate it.
 * Returns nothing, synchronously or asynchronously.
 */
export type RunFn<TContext extends BaseContext> = (
  ctx: TContext,
) => void | Promise<void>;

/**
 * A step's optional guard — a pure predicate over the context. A falsy result
 * skips the step. Guards must not mutate the context or cause side effects;
 * dry-run (§1.2) relies on this contract.
 */
export type GuardFn<TContext extends BaseContext> = (
  ctx: TContext,
) => boolean | Promise<boolean>;

/**
 * A step's optional compensation, run in reverse order during rollback when a
 * later step fails (§1.7).
 */
export type UndoFn<TContext extends BaseContext> = (
  ctx: TContext,
) => void | Promise<void>;

/** Full configuration form accepted by the `Step` constructor (§3.1). */
export interface StepOptions<TContext extends BaseContext> {
  run: RunFn<TContext>;
  when?: GuardFn<TContext>;
  undo?: UndoFn<TContext>;
}

/** Lifecycle status of a single step within a `Result`. */
export type StepStatus =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'would-run';

/** Per-step entry in a `Result`, in pipeline order (§3.4). */
export interface StepReport {
  name: string;
  status: StepStatus;
  /** `performance.now()` delta; `0` for skipped / would-run steps. */
  durationMs: number;
  /** Present for `'failed'` and `'rollback-failed'`. */
  error?: Error;
  /** Present for `'skipped'` (e.g. "guard returned false"). */
  skipReason?: string;
}

/** The structured outcome of `pipeline.execute()` (§3.4). */
export interface Result<TContext extends BaseContext> {
  /** `false` iff a step's run (or a guard) threw and the pipeline aborted. */
  ok: boolean;
  /** Final context, after execution and any rollback. */
  context: TContext;
  /** One entry per step, in pipeline order. */
  steps: StepReport[];
  /** The step failure that aborted the pipeline, if any. */
  error: Error | null;
  /** `undo()` failures gathered during compensation (possibly empty). */
  rollbackErrors: Error[];
}

/** A bundle of an engine's callable methods, as registered on an `Engine`. */
export type EngineMethods = Record<string, (...args: unknown[]) => unknown>;

/**
 * Resolver behind `ctx.engines`: indexed by engine name, each entry is that
 * engine's `EngineMethods`. The concrete Map-backed implementation — which
 * throws a `UsageError` on an unknown name rather than returning `undefined`
 * (§3.5) — lands in `engine.ts` in Phase 5; this is its public type contract.
 */
export type EngineAccessor = Record<string, EngineMethods>;
