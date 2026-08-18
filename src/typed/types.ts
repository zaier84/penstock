import type { BaseContext } from '../context';
import type { Engine } from '../engine';
import type { ExecuteOptions, Pipeline } from '../pipeline';
import type {
  AfterHook,
  BeforeHook,
  ErrorHook,
  LifecycleCallback,
  Result,
  RetryOptions,
  StepMeta,
} from '../types';

/* eslint-disable @typescript-eslint/no-empty-object-type --
 * `{}` is load-bearing throughout this file and cannot be swapped for
 * `object`, `Record<string, unknown>`, or `unknown`. It is the identity
 * element of `Merge`: the state of a pipeline that has produced nothing yet,
 * and the contribution of a step that returns nothing. `Merge<{}, B>` must
 * collapse to exactly `B`, which only the empty object type does. These
 * primitives were verified against TypeScript 5.9 under `strict`, negative
 * tests included (0.5.0 spec, section 2.2); they are used as given.
 */

/**
 * What a step's `run` may return: nothing, or an object merged into the
 * context (0.5.0 spec, section 2.2).
 *
 * The constraint is `object` rather than `Record<string, unknown>` on purpose.
 * An `interface` has no implicit index signature, so a step returning a named
 * domain interface — the normal case — is *not* assignable to
 * `Record<string, unknown>` and would fail to compile. `object` accepts it
 * while still excluding primitives (section 2.1).
 */
export type StepReturn = void | object;

/**
 * Normalises a run's awaited return type into a state contribution: a `void`
 * or `undefined` return contributes nothing, an object contributes itself.
 *
 * The `[T] extends [void]` bracket form is deliberate — it prevents
 * distribution over unions, so a run typed `Promise<A | void>` is judged as a
 * whole rather than being split into two branches. Keep it (section 2.2).
 */
export type StateOf<T> = [T] extends [void]
  ? {}
  : [T] extends [undefined]
    ? {}
    : T extends object
      ? T
      : {};

/**
 * Flattens an intersection into a single object type so editor hovers stay
 * readable — `{ a: string; b: number }` rather than `{ a: string } & { b:
 * number }` repeated down a long chain.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Merges a later contribution over an earlier state, later keys winning. That
 * matches the runtime merge order exactly: a second step writing `v` overwrites
 * the first step's `v` on the shared context, so the type must overwrite too.
 */
export type Merge<A, B> = Simplify<Omit<A, keyof B> & B>;

/**
 * Collapses a union into an intersection, via the contravariance of function
 * parameter positions. Used to combine the contributions of a parallel group's
 * steps, which arrive as a union over the group array's members.
 */
export type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * The context as a step sees it at a given point in the chain: penstock's own
 * {@link BaseContext} fields plus everything the steps before it produced.
 *
 * This is what removes the non-null assertion. In the class API a mid-run field
 * must be declared optional on the context interface, because it does not exist
 * until its step runs — so every later step reads it as `T | undefined` and
 * writes `ctx.reservationId!`. Here the state type grows step by step, so a key
 * is required from the moment the step that produces it has run.
 */
export type TypedCtx<TInput, TState> = BaseContext<TInput> & TState;

/**
 * A pipeline built by {@link pipeline}, where each step declares what it
 * produces and the context type accumulates down the chain (0.5.0 spec,
 * section 2.4).
 *
 * The three type parameters carry the accumulation:
 *
 * - `TInput` — the `execute()` input, fixed for the whole chain.
 * - `TPrev` — the state accumulated **before** the most recent step.
 * - `TLast` — the most recent step's own contribution.
 *
 * The current full state is `Merge<TPrev, TLast>`. Splitting the last
 * contribution out is what makes the chained modifiers work: `.when()` can
 * weaken `TLast` to `Partial<TLast>` because it still knows exactly which keys
 * the guarded step contributed, and `.undo()` can offer `Merge<TPrev, TLast>`
 * with those keys **required**, because a compensation only ever runs for a
 * step that completed (section 2.3).
 *
 * This is a facade: it constructs the same {@link Step} and {@link Pipeline}
 * instances the class API does, so rollback, retry, timeout, cancellation,
 * tracing, lifecycle events, and the `Result` are inherited unchanged rather
 * than reimplemented. {@link TypedPipeline.toPipeline} reaches the pipeline
 * underneath.
 */
export interface TypedPipeline<
  TInput,
  TPrev extends object,
  TLast extends object,
> {
  /**
   * Appends a step. `run` receives the context as it stands — every key
   * produced so far, required — and this invocation's {@link StepMeta}.
   * Whatever object it returns becomes the next state contribution; returning
   * nothing contributes nothing.
   *
   * The run **function type** is inferred and its return extracted with
   * `Awaited<ReturnType<TRun>>`, rather than constraining the return type
   * directly. Constraining it collapses inference to the constraint and every
   * contribution degrades to the constraint type (section 2.1).
   */
  step<
    TRun extends (
      ctx: TypedCtx<TInput, Merge<TPrev, TLast>>,
      meta: StepMeta,
    ) => StepReturn,
  >(
    name: string,
    run: TRun,
  ): TypedPipeline<
    TInput,
    Merge<TPrev, TLast>,
    StateOf<Awaited<ReturnType<TRun>>>
  >;

  /**
   * Guards the most recent step: a falsy result skips it. Its contribution
   * therefore becomes `Partial<TLast>` — the keys may or may not exist by the
   * time later steps run, and the types say so instead of pretending otherwise.
   *
   * The predicate sees `TPrev`, the state *before* the guarded step, since it
   * is evaluated before that step runs. Guards must stay pure: dry-run
   * evaluates them without executing anything (`BUILD_SPEC.md` section 1.2).
   */
  when(
    fn: (ctx: TypedCtx<TInput, TPrev>) => boolean | Promise<boolean>,
  ): TypedPipeline<TInput, TPrev, Partial<TLast>>;

  /**
   * Compensation for the most recent step, run during reverse-order rollback
   * when a later step fails (`BUILD_SPEC.md` section 1.7). It sees
   * `Merge<TPrev, TLast>` with the step's own output **required** — a
   * compensation only runs for a step that completed, so `ctx.reservationId`
   * needs no `!`.
   */
  undo(
    fn: (
      ctx: TypedCtx<TInput, Merge<TPrev, TLast>>,
      meta: StepMeta,
    ) => void | Promise<void>,
  ): TypedPipeline<TInput, TPrev, TLast>;

  /** Retry policy for the most recent step (`PENSTOCK_0.2.0_SPEC.md` section 1.1). */
  retry(options: RetryOptions): TypedPipeline<TInput, TPrev, TLast>;

  /** Per-attempt timeout in milliseconds for the most recent step (section 1.2). */
  timeout(ms: number): TypedPipeline<TInput, TPrev, TLast>;

  /**
   * Idempotency key for the most recent step (`PENSTOCK_0.4.0_SPEC.md` section
   * 1.4). A function is evaluated once, before the first attempt, so it sees
   * `TPrev` — the state before this step ran.
   */
  idempotencyKey(
    key: string | ((ctx: TypedCtx<TInput, TPrev>) => string),
  ): TypedPipeline<TInput, TPrev, TLast>;

  /**
   * Observer hook fired before each executed step (`BUILD_SPEC.md` section 3.2).
   *
   * It sees `Partial<...>` of the accumulated state, and that is type-honest
   * rather than pessimistic: the hook fires for *every* step, so at any given
   * firing only the keys produced so far exist. The same reasoning applies to
   * {@link TypedPipeline.after} and {@link TypedPipeline.onError}; the
   * lifecycle callbacks below fire once at the end and see the full state.
   */
  before(
    hook: BeforeHook<TypedCtx<TInput, Partial<Merge<TPrev, TLast>>>>,
  ): this;

  /** Observer hook fired after each executed step completes (section 3.2). */
  after(hook: AfterHook<TypedCtx<TInput, Partial<Merge<TPrev, TLast>>>>): this;

  /** Observer hook fired once per step failure, before rollback (section 1.7). */
  onError(
    hook: ErrorHook<TypedCtx<TInput, Partial<Merge<TPrev, TLast>>>>,
  ): this;

  /** Lifecycle callback for a successful run (`PENSTOCK_0.3.0_SPEC.md` section 1.3). */
  onComplete(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback for a run that failed on a step, after rollback (section 1.3). */
  onFailure(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback for a run stopped by its `AbortSignal` (section 1.3). */
  onCancel(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback fired always, last (section 1.3). */
  onSettled(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /**
   * Registers a pipeline-scoped engine, shadowing a global one of the same
   * name (`BUILD_SPEC.md` section 3.5). This is the recommended alternative to
   * the deprecated global registry.
   */
  useEngine(engine: Engine): this;

  /**
   * Builds the underlying {@link Pipeline} and runs it. The `Result`'s context
   * is typed with everything the chain produced, so `result.context.chargeId`
   * is a `string`, not `string | undefined`.
   */
  execute(
    input: TInput,
    options?: ExecuteOptions,
  ): Promise<Result<TypedCtx<TInput, Merge<TPrev, TLast>>>>;

  /**
   * Escape hatch to the class API: the {@link Pipeline} this builder describes,
   * with every step, hook, lifecycle callback, and engine already registered.
   * Use it to reach anything the builder does not surface.
   */
  toPipeline(): Pipeline<TypedCtx<TInput, Merge<TPrev, TLast>>>;
}

/* eslint-enable @typescript-eslint/no-empty-object-type */
