import type { BaseContext } from './context';
import type { Step } from './step';

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
 * dry-run (section 1.2) relies on this contract.
 */
export type GuardFn<TContext extends BaseContext> = (
  ctx: TContext,
) => boolean | Promise<boolean>;

/**
 * A step's optional compensation, run in reverse order during rollback when a
 * later step fails (section 1.7).
 */
export type UndoFn<TContext extends BaseContext> = (
  ctx: TContext,
) => void | Promise<void>;

/**
 * Per-step retry policy (section 1.1). `attempts` is the **total** number of
 * tries including the first — `attempts: 3` means try once, then up to two more
 * times — so the minimum is `1` (no retry). Only a step's `run` is retried;
 * guards (`when`) and compensations (`undo`) are never retried.
 */
export interface RetryOptions {
  /** Total tries including the first; minimum `1`. */
  attempts: number;
  /** Base delay between attempts in milliseconds; default `0`, must be `>= 0`. */
  delayMs?: number;
  /**
   * Inter-attempt growth: `'fixed'` (default) keeps every delay at `delayMs`;
   * `'exponential'` doubles it after each failure (`delayMs * 2^attemptIndex`).
   */
  backoff?: 'fixed' | 'exponential';
  /**
   * When `true`, add a uniform random fraction of the computed delay to avoid
   * thundering-herd retries; default `false`.
   */
  jitter?: boolean;
}

/** Full configuration form accepted by the `Step` constructor (section 3.1). */
export interface StepOptions<TContext extends BaseContext> {
  run: RunFn<TContext>;
  when?: GuardFn<TContext>;
  undo?: UndoFn<TContext>;
  /** Per-step retry policy (section 1.1); validated at construction. */
  retry?: RetryOptions;
  /**
   * Per-attempt timeout in milliseconds; must be `> 0` (section 1.2). Validated
   * at construction.
   */
  timeout?: number;
}

/** Lifecycle status of a single step within a `Result`. */
export type StepStatus =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'would-run';

/** Per-step entry in a `Result`, in pipeline order (section 3.4). */
export interface StepReport {
  name: string;
  status: StepStatus;
  /** `performance.now()` delta; `0` for skipped / would-run steps. */
  durationMs: number;
  /** Present for `'failed'` and `'rollback-failed'`. */
  error?: Error;
  /** Present for `'skipped'` (e.g. "guard returned false"). */
  skipReason?: string;
  /**
   * Number of times `run` was called (section 1.4); present when retry is
   * configured. A step that succeeded on its 3rd try reports `attempts: 3`.
   */
  attempts?: number;
  /** `true` when the step failed specifically due to a timeout (section 1.4). */
  timedOut?: boolean;
  /**
   * The nested pipeline's full `Result`, present only for pipeline-as-step
   * entries whose inner pipeline ran (0.3.0 spec, section 1.2.5) — the outer
   * `steps[]` stays flat, so the nested execution is inspectable here without
   * needing `mapResult`.
   */
  // The inner context type is intentionally erased (0.3.0 spec, section 3.2).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  innerResult?: Result<any>;
}

/** The structured outcome of `pipeline.execute()` (section 3.4). */
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
  /**
   * `true` when the pipeline was stopped by its `AbortSignal` (section 1.3.3
   * of the 0.3.0 spec) — detected between entries, during a retry delay, or
   * mid-parallel-group. `false` for step/guard failures, successful runs, and
   * dry-run plans.
   */
  aborted: boolean;
}

/**
 * Internal execution-sequence entry (0.3.0 spec, section 1.1.6): a pipeline is
 * an ordered mix of sequential steps and parallel groups, each group occupying
 * one logical position. Internal — the public API is `addStep`/`addParallel`;
 * this type is not exported from the package.
 */
export type PipelineEntry<TContext extends BaseContext> =
  | { kind: 'sequential'; step: Step<TContext> }
  | { kind: 'parallel'; steps: Step<TContext>[] };

/**
 * Options for `Pipeline.asStep(name, options)` (0.3.0 spec, section 1.2.2),
 * which wraps a whole pipeline as a single `Step` of an outer pipeline. The
 * inner pipeline runs on its **own fresh context**, isolated from the outer
 * one — `mapInput` is the only way in, `mapResult` (and `innerResult` on the
 * wrapping step's report) the way out.
 */
export interface AsStepOptions<
  TOuterContext extends BaseContext,
  TInnerInput = unknown,
> {
  /** Derives the inner pipeline's `input` from the outer context. Required. */
  mapInput: (outerCtx: TOuterContext) => TInnerInput;
  /**
   * Called only when the inner pipeline succeeds (`ok: true`); use it to
   * write inner outputs onto the outer context. Not called on inner failure.
   */
  // The inner context type is intentionally erased (0.3.0 spec, section 3.1).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapResult?: (innerResult: Result<any>, outerCtx: TOuterContext) => void;
  /**
   * Compensation for the wrapping step, run during **outer** rollback when a
   * later outer step fails. The inner pipeline is *not* re-rolled-back — its
   * work is committed; reversing its net effect is this function's job
   * (0.3.0 spec, section 1.2.4, scenario B).
   */
  undo?: UndoFn<TOuterContext>;
  /** Guard on the wrapping step, evaluated in the outer pipeline's context. */
  when?: GuardFn<TOuterContext>;
}

/** A bundle of an engine's callable methods, as registered on an `Engine`. */
export type EngineMethods = Record<string, (...args: unknown[]) => unknown>;

/**
 * Resolver behind `ctx.engines`: indexed by engine name, each entry is that
 * engine's `EngineMethods`. The concrete Map-backed implementation — which
 * throws a `UsageError` on an unknown name rather than returning `undefined`
 * (section 3.5) — lands in `engine.ts` in Phase 5; this is its public type contract.
 */
export type EngineAccessor = Record<string, EngineMethods>;

/**
 * Observer hook fired immediately before an executed step's `run` (section 3.2). Skipped
 * steps fire no hook. A throw/rejection is contained and never alters flow (section 1.8).
 */
export type BeforeHook<TContext extends BaseContext> = (
  ctx: TContext,
  step: Step<TContext>,
) => void | Promise<void>;

/**
 * Observer hook fired after an executed step completes (section 3.2). Receives just the
 * step's outcome — `{ status, durationMs }`, not the full `StepReport`. Skipped
 * steps fire no hook; a throw/rejection is contained (section 1.8).
 */
export type AfterHook<TContext extends BaseContext> = (
  ctx: TContext,
  step: Step<TContext>,
  report: { status: StepStatus; durationMs: number },
) => void | Promise<void>;

/**
 * Observer hook fired once when a step fails, before rollback begins (section 1.7, section 3.2).
 * Observes only; a throw/rejection is contained and never alters flow (section 1.8).
 */
export type ErrorHook<TContext extends BaseContext> = (
  error: Error,
  ctx: TContext,
  step: Step<TContext>,
) => void | Promise<void>;
