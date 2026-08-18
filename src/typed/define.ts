import type { BaseContext } from '../context';
import { UsageError } from '../errors';
import { Step } from '../step';
import type { RetryOptions, RunFn, StepMeta, StepOptions } from '../types';
import { mergeContribution } from './merge';
import type { Merge, StateOf, StepReturn, TypedCtx } from './types';

/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any --
 * `{}` is the empty required-state of a definition that needs nothing, and the
 * empty contribution of one that returns nothing; it is the identity element of
 * `Merge`, which no other type provides. `any` appears only as an inference
 * placeholder in constraint positions, where `RequiresOf` and `ProducesOf`
 * recover the real types immediately. See the note in ./types.ts.
 */

/**
 * The context type used internally, with the caller's tracked state erased.
 * The runtime work of building a step is identical whatever the tracked types
 * are; they are reunited with it by the casts at the public boundaries.
 */
export type ErasedCtx = BaseContext;

export type ErasedRun = (ctx: ErasedCtx, meta: StepMeta) => StepReturn;
export type ErasedGuard = (ctx: ErasedCtx) => boolean | Promise<boolean>;
export type ErasedUndo = (
  ctx: ErasedCtx,
  meta: StepMeta,
) => void | Promise<void>;
export type ErasedKey = string | ((ctx: ErasedCtx) => string);

/**
 * One step as declared, before it becomes a {@link Step}. Construction has to
 * be deferred because a `Step` is immutable while modifiers arrive *after* the
 * call they modify — `.undo()` follows `.step()`, and a `StepDef`'s modifiers
 * follow its definition.
 *
 * This lives here rather than in ./builder.ts so that `define.ts` and
 * `builder.ts` share one construction path without importing each other at
 * runtime.
 */
export interface StepSpec {
  readonly name: string;
  readonly run: ErasedRun;
  when?: ErasedGuard;
  undo?: ErasedUndo;
  retry?: RetryOptions;
  timeout?: number;
  idempotencyKey?: ErasedKey;
}

/**
 * Turns a declared step into a real {@link Step}, wrapping its `run` so the
 * returned contribution reaches the context. Optional config is left truly
 * absent when unset — `Step` and the executor both branch on presence, so an
 * explicit `undefined` would not mean the same thing.
 */
export function toStep(spec: StepSpec): Step<ErasedCtx> {
  const options: StepOptions<ErasedCtx> = { run: wrapRun(spec) };
  if (spec.when !== undefined) {
    options.when = spec.when;
  }
  if (spec.undo !== undefined) {
    options.undo = spec.undo;
  }
  if (spec.retry !== undefined) {
    options.retry = spec.retry;
  }
  if (spec.timeout !== undefined) {
    options.timeout = spec.timeout;
  }
  if (spec.idempotencyKey !== undefined) {
    options.idempotencyKey = spec.idempotencyKey;
  }
  return new Step<ErasedCtx>(spec.name, options);
}

/**
 * The merge wrapper — the one piece of new runtime behaviour in the release
 * (0.5.0 spec, section 3.1). It runs the user's function and merges whatever it
 * returned onto the context.
 *
 * A run that throws never reaches the merge, so a failed attempt contributes
 * nothing and a step that succeeds on its third try contributes exactly once
 * (section 3.2).
 *
 * The `meta.signal.aborted` check closes a real gap (section 3.3). `runAttempt`
 * races a timed-out run against its timeout and moves on, but the abandoned
 * promise keeps going and eventually resolves — with the class API it can still
 * mutate the context long after the pipeline has finished. Returning early here
 * means a run whose own signal has aborted, by timeout or by cancellation,
 * cannot write.
 */
function wrapRun(spec: StepSpec): RunFn<ErasedCtx> {
  return async (ctx, meta) => {
    const contribution = await spec.run(ctx, meta);
    if (meta.signal.aborted) {
      return;
    }
    mergeContribution(ctx, contribution, spec.name);
  };
}

/**
 * Phantom brand. It is `declare`d, so it exists only in the type system and
 * never at runtime — its whole job is to carry the three type parameters on an
 * interface that is otherwise structurally plain, so `RequiresOf` and
 * `ProducesOf` can recover them.
 */
declare const BRAND: unique symbol;

/**
 * A reusable step definition created by {@link defineStep} (0.5.0 spec, section
 * 2.5): a named unit of work that declares what prior state it **requires** and
 * what it **produces**, independently of any one pipeline.
 *
 * Modifiers return a **new** definition rather than mutating this one,
 * mirroring `Step.prototype.when`. A definition is therefore safe to share
 * between pipelines, and to derive variants from.
 */
export interface StepDef<
  TInput,
  TRequires extends object,
  TProduces extends object,
> {
  readonly [BRAND]: { i: TInput; r: TRequires; p: TProduces };
  /** The step's name, as declared. */
  readonly name: string;
  /** The constructed {@link Step}, which the builder registers for a group. */
  readonly step: Step<any>;
  /**
   * Guards this definition. Its contribution becomes `Partial<TProduces>`,
   * exactly as the builder's own `.when()` weakens a step's contribution: a
   * guarded step may not have run.
   */
  when(
    fn: (ctx: TypedCtx<TInput, TRequires>) => boolean | Promise<boolean>,
  ): StepDef<TInput, TRequires, Partial<TProduces>>;
  /**
   * Compensation for this definition. It sees its own output as **required** —
   * a compensation only ever runs for a step that completed.
   */
  undo(
    fn: (
      ctx: TypedCtx<TInput, Merge<TRequires, TProduces>>,
      meta: StepMeta,
    ) => void | Promise<void>,
  ): StepDef<TInput, TRequires, TProduces>;
  retry(options: RetryOptions): StepDef<TInput, TRequires, TProduces>;
  timeout(ms: number): StepDef<TInput, TRequires, TProduces>;
  idempotencyKey(
    key: string | ((ctx: TypedCtx<TInput, TRequires>) => string),
  ): StepDef<TInput, TRequires, TProduces>;
}

/** The prior state a definition requires, or the empty state if it declares none. */
export type RequiresOf<T> =
  T extends StepDef<any, infer TRequires, any> ? TRequires : {};

/** What a definition contributes to the context. */
export type ProducesOf<T> =
  T extends StepDef<any, any, infer TProduces> ? TProduces : {};

/**
 * Every definition's underlying spec, keyed by the definition itself. A
 * `WeakMap` rather than a property, so the public type stays exactly the shape
 * documented above and the spec never reaches the emitted declarations — the
 * same pattern `pipeline.ts` uses for its per-run inner results and trace
 * handles.
 */
const specs = new WeakMap<object, StepSpec>();

/**
 * The spec behind a definition. Throws if handed something that is not one,
 * which is the only way `use` can tell a stray object from a definition: the
 * brand is a type-level fiction with no runtime trace.
 */
export function specOf(
  def: object,
  pipelineName: string,
  method: string,
): StepSpec {
  const spec = specs.get(def);
  if (spec === undefined) {
    throw new UsageError(
      `Pipeline "${pipelineName}" .${method}() expected a step definition created ` +
        `by defineStep(). Create one with defineStep<Input>()(name, run), then pass ` +
        `it here.`,
    );
  }
  return spec;
}

/** Builds a definition and its constructed step from a spec. */
function makeDef(spec: StepSpec): StepDef<unknown, never, never> {
  const derive = (changes: Partial<StepSpec>): StepDef<unknown, never, never> =>
    makeDef({ ...spec, ...changes });

  const def = {
    name: spec.name,
    step: toStep(spec),
    when: (fn: ErasedGuard) => derive({ when: fn }),
    undo: (fn: ErasedUndo) => derive({ undo: fn }),
    retry: (options: RetryOptions) => derive({ retry: options }),
    timeout: (ms: number) => derive({ timeout: ms }),
    idempotencyKey: (key: ErasedKey) => derive({ idempotencyKey: key }),
    // The brand is `declare`d and so has no runtime counterpart; this cast is
    // where the phantom type parameters are attached.
  } as unknown as StepDef<unknown, never, never>;

  specs.set(def, spec);
  return def;
}

/**
 * Defines a reusable, independently-typed step (0.5.0 spec, section 2.5).
 *
 * The call is in **two stages** because TypeScript has no partial type-argument
 * inference: supplying `TInput` explicitly would force you to supply the run
 * function's type too, defeating inference of what the step produces. The first
 * call fixes `TInput` and the required prior state; the second infers the run.
 *
 * ```ts
 * const forOrder = defineStep<OrderInput>();
 * const fetchUser = forOrder('fetch-user', async (ctx) => ({
 *   user: await get(ctx.input.id),
 * }));
 *
 * // Declaring a requirement makes misordering a compile error:
 * const callApi = defineStep<OrderInput, { token: string }>()(
 *   'call-api',
 *   async (ctx) => ({ profile: await call(ctx.token) }),
 * );
 * ```
 *
 * `use(callApi)` before the step that produces `token` does not compile. The
 * name is validated here, at definition time, because the `Step` is built now.
 */
export function defineStep<TInput, TRequires extends object = {}>(): <
  TRun extends (ctx: TypedCtx<TInput, TRequires>, meta: StepMeta) => StepReturn,
>(
  name: string,
  run: TRun,
) => StepDef<TInput, TRequires, StateOf<Awaited<ReturnType<TRun>>>> {
  return (name, run) =>
    makeDef({ name, run: run as unknown as ErasedRun }) as unknown as StepDef<
      TInput,
      TRequires,
      StateOf<Awaited<ReturnType<typeof run>>>
    >;
}

/* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any */
