import type { BaseContext } from '../context';
import type { Engine } from '../engine';
import type { ExecuteOptions, Pipeline } from '../pipeline';
import type {
  AfterHook,
  BeforeHook,
  ErrorHook,
  LifecycleCallback,
  ParallelOptions,
  Result,
  RetryOptions,
  StepMeta,
} from '../types';
import type { ProducesOf, RequiresOf, StepDef } from './define';

/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any --
 * `any` appears only as an inference placeholder in constraint positions —
 * `StepDef<TInput, any, any>`, `TypedPipeline<any, any, any>` — where the real
 * types are recovered immediately by `RequiresOf`, `ProducesOf`, `InnerInputOf`
 * and `InnerCtxOf`. `unknown` cannot stand in: it fails the `extends object`
 * constraints these positions carry.
 *
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
 * context.
 *
 * The constraint is `object` rather than `Record<string, unknown>` on purpose.
 * An `interface` has no implicit index signature, so a step returning a named
 * domain interface — the normal case — is *not* assignable to
 * `Record<string, unknown>` and would fail to compile. `object` accepts it
 * while still excluding primitives.
 */
export type StepReturn = void | object;

/**
 * Normalises a run's awaited return type into a state contribution: a `void`
 * or `undefined` return contributes nothing, an object contributes itself.
 *
 * The `[T] extends [void]` bracket form is deliberate — it prevents
 * distribution over unions, so a run typed `Promise<A | void>` is judged as a
 * whole rather than being split into two branches. Keep it.
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
 * produces and the context type accumulates down the chain.
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
 * step that completed.
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
   * contribution degrades to the constraint type.
   *
   * @param name - Name for the step, unique within this pipeline.
   * @param run - The work. Whatever object it returns is merged onto the
   * context and added to the accumulated type; returning nothing contributes
   * nothing.
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
   * Appends a reusable step definition created by `defineStep`. Its
   * contribution becomes the new `TLast`, exactly as if the step had been
   * declared inline.
   *
   * A definition may declare a **required prior state**, and the conditional in
   * the parameter type enforces it: if the state accumulated so far does not
   * satisfy `RequiresOf<TDef>`, the parameter resolves to `never` and the call
   * fails to compile. Composing steps in the wrong order is therefore a type
   * error rather than a runtime `undefined`.
   *
   * @param def - A definition from `defineStep`. Does not compile if the state
   * accumulated so far does not satisfy what it declares it requires.
   */
  use<TDef extends StepDef<TInput, any, any>>(
    def: Merge<TPrev, TLast> extends RequiresOf<TDef> ? TDef : never,
  ): TypedPipeline<TInput, Merge<TPrev, TLast>, ProducesOf<TDef>>;

  /**
   * Appends a parallel group. Every
   * definition's contribution is intersected into the new `TLast`, so a later
   * step sees all of them.
   *
   * It takes an **array**, not an object, and deliberately: declaration order
   * defines rollback order and which failure becomes `result.error`, and
   * JavaScript reorders integer-like keys in objects — so an object form would
   * silently reorder a group containing a step named `"1"`. Modifiers belong on
   * the individual `StepDef`s, not on the group.
   *
   * @param defs - At least two definitions. Declaration order decides rollback
   * order, dispatch order under a cap, and which failure becomes
   * `result.error`.
   * @param options - `concurrency` caps how many run at once.
   */
  parallel<TDefs extends readonly StepDef<TInput, any, any>[]>(
    defs: TDefs,
    options?: ParallelOptions,
  ): TypedPipeline<
    TInput,
    Merge<TPrev, TLast>,
    Simplify<UnionToIntersection<ProducesOf<TDefs[number]>>> extends infer O
      ? O extends object
        ? O
        : {}
      : {}
  >;

  /**
   * Nests another pipeline as a single step. `mapInput` derives the inner
   * pipeline's input from the outer context; `mapResult` turns the inner
   * `Result` into a contribution, which is merged on the outer context exactly
   * like a step's return.
   *
   * That is the one place this differs from the class API's `asStep`, whose
   * `mapResult` returns `void` and writes onto the outer context by hand. Here
   * it **returns** the contribution, so the accumulated type follows it.
   * Omitting `mapResult` contributes nothing while still running the inner
   * pipeline for its effects.
   *
   * The inner pipeline may be another typed pipeline or a class-API
   * {@link Pipeline}; the overloads accept either.
   *
   * @param name - Name for the wrapping step in this pipeline.
   * @param inner - The pipeline to nest. It runs on its own fresh context and
   * resolves its own engines.
   * @param options - `mapInput` derives the inner input; `mapResult` turns the
   * inner `Result` into a contribution for this pipeline.
   */
  compose<
    TInner extends TypedPipeline<any, any, any>,
    TOpts extends TypedComposeOptions<
      TypedCtx<TInput, Merge<TPrev, TLast>>,
      InnerInputOf<TInner>,
      InnerCtxOf<TInner>
    >,
  >(
    name: string,
    inner: TInner,
    options: TOpts,
  ): TypedPipeline<
    TInput,
    Merge<TPrev, TLast>,
    ComposeContribution<TOpts> extends infer O
      ? O extends object
        ? O
        : {}
      : {}
  >;
  compose<
    TInnerCtx extends BaseContext,
    TOpts extends TypedComposeOptions<
      TypedCtx<TInput, Merge<TPrev, TLast>>,
      TInnerCtx['input'],
      TInnerCtx
    >,
  >(
    name: string,
    inner: Pipeline<TInnerCtx>,
    options: TOpts,
  ): TypedPipeline<
    TInput,
    Merge<TPrev, TLast>,
    ComposeContribution<TOpts> extends infer O
      ? O extends object
        ? O
        : {}
      : {}
  >;

  /**
   * Guards the most recent step: a falsy result skips it. Its contribution
   * therefore becomes `Partial<TLast>` — the keys may or may not exist by the
   * time later steps run, and the types say so instead of pretending otherwise.
   *
   * The predicate sees `TPrev`, the state *before* the guarded step, since it
   * is evaluated before that step runs. Guards must stay pure: dry-run
   * evaluates them without executing anything.
   *
   * @param fn - Pure predicate over the state before the guarded step. A falsy
   * result skips it.
   */
  when(
    fn: (ctx: TypedCtx<TInput, TPrev>) => boolean | Promise<boolean>,
  ): TypedPipeline<TInput, TPrev, Partial<TLast>>;

  /**
   * Compensation for the most recent step, run during reverse-order rollback
   * when a later step fails. It sees
   * `Merge<TPrev, TLast>` with the step's own output **required** — a
   * compensation only runs for a step that completed, so `ctx.reservationId`
   * needs no `!`.
   *
   * @param fn - The compensation. It sees the guarded step's own output as
   * required, plus this invocation's {@link StepMeta}.
   */
  undo(
    fn: (
      ctx: TypedCtx<TInput, Merge<TPrev, TLast>>,
      meta: StepMeta,
    ) => void | Promise<void>,
  ): TypedPipeline<TInput, TPrev, TLast>;

  /** Retry policy for the most recent step. */
  retry(options: RetryOptions): TypedPipeline<TInput, TPrev, TLast>;

  /** Per-attempt timeout in milliseconds for the most recent step. */
  timeout(ms: number): TypedPipeline<TInput, TPrev, TLast>;

  /**
   * Idempotency key for the most recent step. A function is evaluated once,
   * before the first attempt, so it sees `TPrev` — the state before this step
   * ran.
   */
  idempotencyKey(
    key: string | ((ctx: TypedCtx<TInput, TPrev>) => string),
  ): TypedPipeline<TInput, TPrev, TLast>;

  /**
   * Observer hook fired before each executed step.
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

  /** Observer hook fired after each executed step completes. */
  after(hook: AfterHook<TypedCtx<TInput, Partial<Merge<TPrev, TLast>>>>): this;

  /** Observer hook fired once per step failure, before rollback. */
  onError(
    hook: ErrorHook<TypedCtx<TInput, Partial<Merge<TPrev, TLast>>>>,
  ): this;

  /** Lifecycle callback for a successful run. */
  onComplete(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback for a run that failed on a step, after rollback. */
  onFailure(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback for a run stopped by its `AbortSignal`. */
  onCancel(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /** Lifecycle callback fired always, last. */
  onSettled(
    callback: LifecycleCallback<TypedCtx<TInput, Merge<TPrev, TLast>>>,
  ): this;

  /**
   * Registers a pipeline-scoped engine, shadowing a global one of the same
   * name. This is the recommended alternative to
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

/**
 * The inner pipeline's `execute()` input, recovered from a
 * {@link TypedPipeline}, so `compose`'s `mapInput` is checked against the
 * pipeline it actually feeds.
 */
export type InnerInputOf<T> =
  T extends TypedPipeline<infer TInput, any, any> ? TInput : never;

/**
 * The inner pipeline's fully accumulated context, recovered from a
 * {@link TypedPipeline}. It is what `compose`'s `mapResult` sees as
 * `inner.context`, so the inner chain's own accumulation survives the nesting
 * instead of collapsing to a bare {@link BaseContext}.
 */
export type InnerCtxOf<T> =
  T extends TypedPipeline<infer TInput, infer TPrev, infer TLast>
    ? TypedCtx<TInput, Merge<TPrev, TLast>>
    : never;

/**
 * Options for {@link TypedPipeline.compose}.
 *
 * Deliberately **not** `AsStepOptions`. There, `mapResult` returns `void` and
 * writes onto the outer context by hand; here it **returns** a contribution,
 * which the builder merges through the same single path a step's return takes
 * — which is what lets the accumulated type follow it.
 *
 * `when` and `undo` are absent on purpose: they are builder modifiers, chained
 * after `.compose(...)` exactly as they are after `.step(...)`.
 */
export interface TypedComposeOptions<
  TOuterCtx,
  TInnerInput,
  TInnerCtx extends BaseContext,
> {
  /** Derives the inner pipeline's input from the outer context. Required. */
  mapInput: (ctx: TOuterCtx) => TInnerInput;
  /**
   * Turns the inner `Result` into a contribution for the outer context, called
   * only when the inner pipeline succeeded. May be async — its resolved value
   * is what contributes.
   */
  mapResult?: (inner: Result<TInnerCtx>, ctx: TOuterCtx) => StepReturn;
}

/**
 * What a `compose` call contributes: whatever its `mapResult` resolves to, or
 * nothing at all when there is no `mapResult`.
 *
 * This has to be a **conditional on the options type**. The obvious
 * `StateOf<Awaited<ReturnType<NonNullable<TOpts['mapResult']>>>>` fails to
 * compile once `mapResult` is omitted: the property is then `undefined`,
 * `NonNullable` of it is `never`, and `ReturnType<never>` is an error. Matching
 * the property out of the object type instead simply misses, yielding the
 * empty state.
 */
export type ComposeContribution<TOpts> = TOpts extends {
  mapResult: (...args: never[]) => infer TReturn;
}
  ? StateOf<Awaited<TReturn>>
  : {};

/* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any */
