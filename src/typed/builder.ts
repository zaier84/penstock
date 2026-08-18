import type { BaseContext } from '../context';
import type { Engine } from '../engine';
import { UsageError } from '../errors';
import { assertSafeName } from '../internal';
import { Pipeline } from '../pipeline';
import type { ExecuteOptions } from '../pipeline';
import { Step } from '../step';
import type {
  AfterHook,
  BeforeHook,
  ErrorHook,
  LifecycleCallback,
  Result,
  RetryOptions,
  RunFn,
  StepMeta,
  StepOptions,
} from '../types';
import { mergeContribution } from './merge';
import type { StepReturn, TypedPipeline } from './types';

/**
 * The context type the builder uses internally. Its public generics exist to
 * track accumulated state for the *caller*; the runtime work is identical
 * whatever they are, so everything below is written against the erased context
 * and reunited with the tracked types by the single cast in {@link pipeline}.
 */
type ErasedCtx = BaseContext;

type ErasedRun = (ctx: ErasedCtx, meta: StepMeta) => StepReturn;
type ErasedGuard = (ctx: ErasedCtx) => boolean | Promise<boolean>;
type ErasedUndo = (ctx: ErasedCtx, meta: StepMeta) => void | Promise<void>;
type ErasedKey = string | ((ctx: ErasedCtx) => string);

/**
 * One step as declared so far. The builder cannot construct its `Step` eagerly:
 * a `Step` is immutable, and `.undo()` / `.retry()` and friends arrive *after*
 * the `.step()` call they modify. So each step is held as a mutable record and
 * turned into a real `Step` only when the pipeline is built.
 */
interface StepSpec {
  readonly name: string;
  readonly run: ErasedRun;
  when?: ErasedGuard;
  undo?: ErasedUndo;
  retry?: RetryOptions;
  timeout?: number;
  idempotencyKey?: ErasedKey;
}

/**
 * The runtime behind {@link TypedPipeline}. It is a **facade**: it records what
 * was declared and, on demand, assembles exactly the `Step` and `Pipeline`
 * instances the class API would have been given by hand. Execution, rollback,
 * retry, timeout, cancellation, tracing, and lifecycle events are the
 * executor's, untouched (0.5.0 spec, section 3.6).
 *
 * Only the merge wrapper is new behaviour, and it lives inside each `Step`'s
 * `run` — so a pipeline reached through {@link toPipeline} behaves identically
 * to one reached through {@link execute}.
 */
class TypedPipelineBuilder {
  private readonly pipelineName: string;
  private readonly specs: StepSpec[] = [];
  // Step-name dedup, so a duplicate fails at the offending `.step()` call
  // rather than when the pipeline is eventually built. A Set, never a
  // user-keyed plain object (section 1.10). `Pipeline.addStep` re-checks
  // authoritatively at build time.
  private readonly names = new Set<string>();
  private readonly engines: Engine[] = [];
  private readonly beforeHooks: BeforeHook<ErasedCtx>[] = [];
  private readonly afterHooks: AfterHook<ErasedCtx>[] = [];
  private readonly errorHooks: ErrorHook<ErasedCtx>[] = [];
  private readonly completeCallbacks: LifecycleCallback<ErasedCtx>[] = [];
  private readonly failureCallbacks: LifecycleCallback<ErasedCtx>[] = [];
  private readonly cancelCallbacks: LifecycleCallback<ErasedCtx>[] = [];
  private readonly settledCallbacks: LifecycleCallback<ErasedCtx>[] = [];
  // Memoised build, discarded whenever anything is declared. Building is pure
  // and cheap, so this is only to keep repeated `execute` calls from
  // reconstructing the same steps.
  private built: Pipeline<ErasedCtx> | undefined;

  constructor(name: string) {
    // Eagerly, because the pipeline itself is not constructed until build time
    // and a bad name is misuse that must fail at the call that made it.
    assertSafeName('Pipeline', name);
    this.pipelineName = name;
  }

  step(name: string, run: ErasedRun): this {
    assertSafeName('Step', name);
    if (this.names.has(name)) {
      throw new UsageError(
        `Pipeline "${this.pipelineName}" already has a step named "${name}"`,
      );
    }
    this.names.add(name);
    this.specs.push({ name, run });
    this.built = undefined;
    return this;
  }

  when(fn: ErasedGuard): this {
    this.modify('when').when = fn;
    return this;
  }

  undo(fn: ErasedUndo): this {
    this.modify('undo').undo = fn;
    return this;
  }

  retry(options: RetryOptions): this {
    this.modify('retry').retry = options;
    return this;
  }

  timeout(ms: number): this {
    this.modify('timeout').timeout = ms;
    return this;
  }

  idempotencyKey(key: ErasedKey): this {
    this.modify('idempotencyKey').idempotencyKey = key;
    return this;
  }

  before(hook: BeforeHook<ErasedCtx>): this {
    this.beforeHooks.push(hook);
    this.built = undefined;
    return this;
  }

  after(hook: AfterHook<ErasedCtx>): this {
    this.afterHooks.push(hook);
    this.built = undefined;
    return this;
  }

  onError(hook: ErrorHook<ErasedCtx>): this {
    this.errorHooks.push(hook);
    this.built = undefined;
    return this;
  }

  onComplete(callback: LifecycleCallback<ErasedCtx>): this {
    this.completeCallbacks.push(callback);
    this.built = undefined;
    return this;
  }

  onFailure(callback: LifecycleCallback<ErasedCtx>): this {
    this.failureCallbacks.push(callback);
    this.built = undefined;
    return this;
  }

  onCancel(callback: LifecycleCallback<ErasedCtx>): this {
    this.cancelCallbacks.push(callback);
    this.built = undefined;
    return this;
  }

  onSettled(callback: LifecycleCallback<ErasedCtx>): this {
    this.settledCallbacks.push(callback);
    this.built = undefined;
    return this;
  }

  useEngine(engine: Engine): this {
    this.engines.push(engine);
    this.built = undefined;
    return this;
  }

  execute(
    input: unknown,
    options?: ExecuteOptions,
  ): Promise<Result<ErasedCtx>> {
    return this.toPipeline().execute(input, options);
  }

  toPipeline(): Pipeline<ErasedCtx> {
    this.built ??= this.build();
    return this.built;
  }

  /**
   * Returns the step a modifier applies to — always the most recently declared
   * one — and invalidates the memoised build. A modifier with no step to attach
   * to is misuse and fails fast (0.5.0 spec, section 3.5).
   *
   * Applying the same modifier twice **replaces** the earlier value rather than
   * combining or throwing, mirroring `Step.prototype.when`.
   */
  private modify(modifier: string): StepSpec {
    const spec = this.specs[this.specs.length - 1];
    if (spec === undefined) {
      throw new UsageError(
        `Pipeline "${this.pipelineName}" .${modifier}() must follow a step. ` +
          `Add a step with .step(name, run) first; modifiers apply to the most ` +
          `recent step.`,
      );
    }
    this.built = undefined;
    return spec;
  }

  /**
   * Assembles the class-API pipeline this builder describes. Engines are
   * registered before the steps so a step's `run` can resolve them, and hooks
   * and lifecycle callbacks are replayed in declaration order — the order they
   * will fire in.
   */
  private build(): Pipeline<ErasedCtx> {
    const pipeline = new Pipeline<ErasedCtx>(this.pipelineName);
    for (const engine of this.engines) {
      pipeline.useEngine(engine);
    }
    for (const spec of this.specs) {
      pipeline.addStep(toStep(spec));
    }
    for (const hook of this.beforeHooks) {
      pipeline.before(hook);
    }
    for (const hook of this.afterHooks) {
      pipeline.after(hook);
    }
    for (const hook of this.errorHooks) {
      pipeline.onError(hook);
    }
    for (const callback of this.completeCallbacks) {
      pipeline.onComplete(callback);
    }
    for (const callback of this.failureCallbacks) {
      pipeline.onFailure(callback);
    }
    for (const callback of this.cancelCallbacks) {
      pipeline.onCancel(callback);
    }
    for (const callback of this.settledCallbacks) {
      pipeline.onSettled(callback);
    }
    return pipeline;
  }
}

/**
 * Turns a declared step into a real {@link Step}, wrapping its `run` so the
 * returned contribution reaches the context. Optional config is left truly
 * absent when unset — `Step` and the executor both branch on presence, so an
 * explicit `undefined` would not mean the same thing.
 */
function toStep(spec: StepSpec): Step<ErasedCtx> {
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

/* eslint-disable @typescript-eslint/no-empty-object-type --
 * `{}` is the empty starting state: a pipeline that has produced nothing yet.
 * It is the identity element of `Merge`, which no other type provides. See the
 * note in ./types.ts.
 */

/**
 * Starts a typed pipeline (0.5.0 spec, section 2.4). Each `.step()` declares
 * what it produces and the context type accumulates down the chain, so a key is
 * required from the moment its step has run:
 *
 * ```ts
 * const checkout = pipeline<OrderInput>('checkout')
 *   .step('reserve', async (ctx) => reserve(ctx.input.items))
 *   .undo(async (ctx) => release(ctx.reservationId))   // required, no `!`
 *   .step('charge', async (ctx) => ({
 *     chargeId: await charge(ctx.input.card, ctx.reservationId),
 *   }));
 *
 * const result = await checkout.execute(input);
 * result.context.chargeId; // string
 * ```
 *
 * The returned object is the builder above. The cast is what joins the two
 * halves of the design: the class carries the behaviour, which is the same
 * whatever the type parameters are, and {@link TypedPipeline} carries the state
 * accumulation, which exists only at compile time. Every method the interface
 * promises is exercised through it by the type tests.
 */
export function pipeline<TInput>(name: string): TypedPipeline<TInput, {}, {}> {
  return new TypedPipelineBuilder(name) as unknown as TypedPipeline<
    TInput,
    {},
    {}
  >;
}

/* eslint-enable @typescript-eslint/no-empty-object-type */
