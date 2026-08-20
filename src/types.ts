import type { BaseContext } from './context';
import type { Step } from './step';

/**
 * Per-invocation metadata handed to a step's `run` and `undo` as a second
 * argument. It identifies *this* invocation — which
 * execution, which attempt, under which idempotency key, and with which
 * `AbortSignal` — none of which the shared context can express, since one
 * context is threaded through every step of a run and shared by the concurrent
 * steps of a parallel group.
 *
 * Guards deliberately receive no metadata: they are contractually pure
 * predicates that dry-run relies on evaluating safely, and an
 * attempt number or an idempotency key would invite side-effectful guards.
 */
export interface StepMeta {
  /** The step's name, as declared. */
  readonly stepName: string;
  /** The pipeline's name. */
  readonly pipelineName: string;
  /** Unique id for this `execute()` call. */
  readonly executionId: string;
  /** 1-based attempt number. Always `1` for `undo` — compensations are not retried. */
  readonly attempt: number;
  /** Total attempts permitted for this step (`1` when no retry is configured). */
  readonly maxAttempts: number;
  /** Stable across every attempt of this step within this execution. */
  readonly idempotencyKey: string;
  /**
   * This invocation's own signal: the per-attempt timeout combined with the
   * parallel group's signal (when inside a group) and the pipeline signal,
   * created fresh per attempt. Prefer it over `ctx.signal` inside a step —
   * `ctx.signal` answers only "was the whole pipeline cancelled".
   * For `undo` it is the pipeline signal: a compensation must be allowed to
   * finish, so it is not bound by the step's timeout.
   */
  readonly signal: AbortSignal;
}

/**
 * The work a `Step` performs: receives the shared context (which it may mutate)
 * and this invocation's {@link StepMeta}. Returns nothing, synchronously or
 * asynchronously. A function declaring fewer parameters stays valid — JavaScript
 * ignores surplus arguments — so single-argument runs are unaffected.
 */
export type RunFn<TContext extends BaseContext> = (
  ctx: TContext,
  meta: StepMeta,
) => void | Promise<void>;

/**
 * A step's optional guard — a pure predicate over the context. A falsy result
 * skips the step. Guards must not mutate the context or cause side effects;
 * dry-run relies on this contract. Guards take the context alone.
 */
export type GuardFn<TContext extends BaseContext> = (
  ctx: TContext,
) => boolean | Promise<boolean>;

/**
 * A step's optional compensation, run in reverse order during rollback when a
 * later step fails. Like `run` it receives the context and this
 * invocation's {@link StepMeta} — whose `idempotencyKey` is the undo key and
 * whose `signal` is the pipeline signal.
 */
export type UndoFn<TContext extends BaseContext> = (
  ctx: TContext,
  meta: StepMeta,
) => void | Promise<void>;

/**
 * Per-step retry policy. `attempts` is the **total** number of
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

/** Full configuration form accepted by the `Step` constructor. */
export interface StepOptions<TContext extends BaseContext> {
  run: RunFn<TContext>;
  when?: GuardFn<TContext>;
  undo?: UndoFn<TContext>;
  /** Per-step retry policy; validated at construction. */
  retry?: RetryOptions;
  /**
   * Per-attempt timeout in milliseconds; must be `> 0`. Validated
   * at construction.
   */
  timeout?: number;
  /**
   * Overrides this step's idempotency key, which
   * defaults to `` `${executionId}:${stepName}` ``. A string is used verbatim; a
   * function is evaluated **once per step invocation, before the first attempt**,
   * and its result reused for every retry — re-evaluating per attempt would
   * defeat the purpose. A non-string, empty string, or non-function value throws
   * a `UsageError` at construction; a function that throws at runtime is a step
   * failure, not misuse.
   */
  idempotencyKey?: string | ((ctx: TContext) => string);
}

/** Lifecycle status of a single step within a `Result`. */
export type StepStatus =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'would-run';

/** Per-step entry in a `Result`, in pipeline order. */
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
   * Number of times `run` was called; present when retry is
   * configured. A step that succeeded on its 3rd try reports `attempts: 3`.
   */
  attempts?: number;
  /** `true` when the step failed specifically due to a timeout. */
  timedOut?: boolean;
  /**
   * The nested pipeline's full `Result`, present only for pipeline-as-step
   * entries whose inner pipeline ran — the outer
   * `steps[]` stays flat, so the nested execution is inspectable here without
   * needing `mapResult`.
   */
  // The inner context type is intentionally erased (0.3.0 spec, section 3.2).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  innerResult?: Result<any>;
  /**
   * The idempotency key this step's `run` was invoked with, making
   * retry-safety auditable from the `Result`. Present for every step that ran;
   * absent for skipped and would-run entries.
   */
  idempotencyKey?: string;
}

/** The structured outcome of `pipeline.execute()`. */
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
   * `true` when the pipeline was stopped by its `AbortSignal` — detected
   * between entries, during a retry delay, or mid-parallel-group. `false` for
   * step/guard failures, successful runs, and dry-run plans.
   */
  aborted: boolean;
  /**
   * Unique id for this `execute()` call, equal to
   * `context.executionId`. A pipeline run via `asStep` is a separate execution
   * with its own id, correlated through `StepReport.innerResult`.
   */
  executionId: string;
  /** The pipeline's name, so a `Result` is self-describing once detached. */
  pipelineName: string;
  /**
   * Total wall-clock time for the `execute()` call in milliseconds, measured
   * with `performance.now()` and including any rollback.
   */
  durationMs: number;
}

/**
 * Options for `serializeResult`.
 */
export interface SerializeOptions {
  /**
   * Include `result.context` in the output. Default `false` — a security
   * decision matching the log-hygiene invariant: a serialized
   * `Result` is destined for a log aggregator, and contexts routinely hold
   * PII, tokens, and payment details. Opting in means opting into that.
   */
  includeContext?: boolean;
  /** Include error stacks. Default `true`. */
  includeStacks?: boolean;
  /** Maximum depth to follow error `cause` chains. Default `5`. */
  maxCauseDepth?: number;
}

/**
 * A JSON-safe rendering of a thrown value. Anything
 * that is not an `Error` — `throw 'boom'`, `throw 42`, `throw null` — becomes
 * `{ name: 'UnknownError', message: String(value) }` rather than crashing the
 * serializer.
 */
export interface SerializedError {
  name: string;
  message: string;
  /** Omitted when `includeStacks` is `false`, or when the value has no stack. */
  stack?: string;
  /** Depth-limited by `maxCauseDepth`; simply absent once the limit is reached. */
  cause?: SerializedError;
  /**
   * Custom own-enumerable properties, so `StepError.stepName` and users' own
   * error fields survive. An `AggregateError` also carries `errors`
   * (a `SerializedError[]`), and a `PipelineError` its `result` (a nested
   * `SerializedResult`, honouring the same options).
   */
  [key: string]: unknown;
}

/** A JSON-safe rendering of a {@link StepReport}. */
export interface SerializedStepReport {
  name: string;
  status: StepStatus;
  durationMs: number;
  error?: SerializedError;
  skipReason?: string;
  attempts?: number;
  timedOut?: boolean;
  idempotencyKey?: string;
  /** The nested pipeline's serialized `Result`, under the same options. */
  innerResult?: SerializedResult;
}

/**
 * A JSON-safe rendering of a {@link Result},
 * produced by `serializeResult` and guaranteed to survive `JSON.stringify`.
 */
export interface SerializedResult {
  ok: boolean;
  aborted: boolean;
  executionId: string;
  pipelineName: string;
  durationMs: number;
  error: SerializedError | null;
  rollbackErrors: SerializedError[];
  steps: SerializedStepReport[];
  /** Present only when `includeContext: true`. */
  context?: unknown;
}

/**
 * One span in a trace — deliberately the smallest
 * vendor-neutral surface penstock needs, so the core stays
 * zero-runtime-dependency and never imports an OpenTelemetry package. The
 * optional `penstock/otel` adapter maps this onto a real OTel
 * span; any other backend needs only these four methods.
 *
 * Every call penstock makes on a span is contained the way hooks are: a throw
 * is caught, logged at `warn`, and never alters the run.
 */
export interface TraceSpan {
  /**
   * Records one attribute. penstock only ever writes `penstock.*` keys whose
   * values are names, ids, statuses, counts, durations, and the idempotency
   * key — never `ctx.input` or any context value.
   */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Records a thrown value on the span. May receive a non-`Error`. */
  recordException(error: unknown): void;
  /** Sets the span's terminal status; `message` accompanies `'error'`. */
  setStatus(status: 'ok' | 'error', message?: string): void;
  /** Ends the span. penstock guarantees exactly one call per started span. */
  end(): void;
}

/**
 * Starts spans for one execution, supplied per run
 * as `execute(input, { tracer })`. Omitting it emits no spans at all, and
 * dry-run never emits spans whether or not a tracer is supplied.
 */
export interface Tracer {
  /** Start a span. `parent` is the enclosing span, when there is one. */
  startSpan(name: string, parent?: TraceSpan): TraceSpan;
}

/**
 * Options for a parallel group, passed as `addParallel(steps, options)`.
 */
export interface ParallelOptions {
  /**
   * Maximum number of the group's steps running at once — a positive integer,
   * validated at build time. Omitted (the default), or set at or above the
   * group size, runs every step at once, exactly as 0.3.0 does. Guards are
   * still evaluated sequentially before any dispatch, and guard-skipped steps
   * never occupy a slot.
   */
  concurrency?: number;
}

/**
 * Internal execution-sequence entry (0.3.0 spec, section 1.1.6): a pipeline is
 * an ordered mix of sequential steps and parallel groups, each group occupying
 * one logical position. Internal — the public API is `addStep`/`addParallel`;
 * this type is not exported from the package.
 */
export type PipelineEntry<TContext extends BaseContext> =
  | { kind: 'sequential'; step: Step<TContext> }
  | { kind: 'parallel'; steps: Step<TContext>[]; concurrency?: number };

/**
 * Options for `Pipeline.asStep(name, options)`,
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
   * work is committed; reversing its net effect is this function's job.
   */
  undo?: UndoFn<TOuterContext>;
  /** Guard on the wrapping step, evaluated in the outer pipeline's context. */
  when?: GuardFn<TOuterContext>;
}

/**
 * A pipeline-scoped lifecycle callback, registered
 * via `onComplete` / `onFailure` / `onCancel` / `onSettled` and fired once a
 * run has fully settled — after execution and any rollback — with the final
 * `Result`. `Result.aborted` decides `onCancel` vs `onFailure`; `onSettled`
 * always fires last. Lifecycle callbacks are observers: async
 * ones are awaited, and a throw/rejection is contained and logged at `warn`,
 * never altering the `Result` or stopping the remaining callbacks.
 */
export type LifecycleCallback<TContext extends BaseContext> = (
  result: Result<TContext>,
) => void | Promise<void>;

/** A bundle of an engine's callable methods, as registered on an `Engine`. */
export type EngineMethods = Record<string, (...args: unknown[]) => unknown>;

/**
 * Resolver behind `ctx.engines`: indexed by engine name, each entry is that
 * engine's `EngineMethods`. The concrete implementation is `Map`-backed and
 * throws a `UsageError` on an unknown name rather than returning `undefined`.
 */
export type EngineAccessor = Record<string, EngineMethods>;

/**
 * Observer hook fired immediately before an executed step's `run`. Skipped
 * steps fire no hook. A throw/rejection is contained and never alters flow.
 */
export type BeforeHook<TContext extends BaseContext> = (
  ctx: TContext,
  step: Step<TContext>,
) => void | Promise<void>;

/**
 * Observer hook fired after an executed step completes. Receives just the
 * step's outcome — `{ status, durationMs }`, not the full `StepReport`. Skipped
 * steps fire no hook; a throw/rejection is contained.
 */
export type AfterHook<TContext extends BaseContext> = (
  ctx: TContext,
  step: Step<TContext>,
  report: { status: StepStatus; durationMs: number },
) => void | Promise<void>;

/**
 * Observer hook fired once when a step fails, before rollback begins.
 * Observes only; a throw/rejection is contained and never alters flow.
 */
export type ErrorHook<TContext extends BaseContext> = (
  error: Error,
  ctx: TContext,
  step: Step<TContext>,
) => void | Promise<void>;
