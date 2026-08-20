import type { BaseContext } from '../context';
import type { Engine } from '../engine';
import { UsageError } from '../errors';
import { assertSafeName } from '../internal';
import { Pipeline } from '../pipeline';
import type { ExecuteOptions } from '../pipeline';
import type { Step } from '../step';
import type {
  AfterHook,
  BeforeHook,
  ErrorHook,
  LifecycleCallback,
  ParallelOptions,
  Result,
  RetryOptions,
} from '../types';
import type {
  ErasedCtx,
  ErasedGuard,
  ErasedKey,
  ErasedRun,
  ErasedUndo,
  StepSpec,
} from './define';
import { specOf, toStep } from './define';
import type { StepReturn, TypedPipeline } from './types';

/**
 * One position in the pipeline being described. Sequential entries stay
 * modifiable — `.undo()` and friends attach to the most recent one — while a
 * parallel group is closed the moment it is declared, its members having been
 * modified on their own `StepDef`s beforehand.
 */
type Entry =
  | { kind: 'sequential'; spec: StepSpec }
  | { kind: 'parallel'; steps: Step<ErasedCtx>[]; concurrency?: number };

/** The runtime shape of the options {@link TypedPipelineBuilder.compose} takes. */
interface ComposeOptions {
  mapInput: (ctx: ErasedCtx) => unknown;
  mapResult?: (inner: Result<ErasedCtx>, ctx: ErasedCtx) => StepReturn;
}

/** Either kind of inner pipeline `compose` accepts. */
type ComposeTarget =
  | Pipeline<ErasedCtx>
  | { toPipeline(): Pipeline<ErasedCtx> };

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
  private readonly entries: Entry[] = [];
  // Step-name dedup, so a duplicate fails at the offending call rather than
  // when the pipeline is eventually built. A Set, never a user-keyed plain
  // object (section 1.10). `Pipeline` re-checks authoritatively at build time.
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
  // and cheap, so this only keeps repeated `execute` calls from reconstructing
  // the same steps.
  private built: Pipeline<ErasedCtx> | undefined;

  constructor(name: string) {
    // Eagerly, because the pipeline itself is not constructed until build time
    // and a bad name is misuse that must fail at the call that made it.
    assertSafeName('Pipeline', name);
    this.pipelineName = name;
  }

  step(name: string, run: ErasedRun): this {
    return this.pushSpec({ name, run });
  }

  use(def: object): this {
    // The spec is copied, so a builder modifier applied after `.use()` cannot
    // reach back and mutate a definition that may be shared with another
    // pipeline.
    return this.pushSpec({ ...specOf(def, this.pipelineName, 'use') });
  }

  parallel(defs: readonly object[], options?: ParallelOptions): this {
    const steps: Step<ErasedCtx>[] = [];
    const names: string[] = [];
    for (const def of defs) {
      names.push(specOf(def, this.pipelineName, 'parallel').name);
      steps.push((def as { step: Step<ErasedCtx> }).step);
    }
    // The group's own rules — at least two steps, real Step instances, an
    // integer concurrency, no duplicate names within the group — are checked by
    // running the authority itself against a scratch pipeline. That keeps the
    // errors identical to the class API's and makes it impossible for the two
    // to drift, at the cost of one discarded object per declaration.
    new Pipeline<ErasedCtx>(this.pipelineName).addParallel(steps, options);
    // Uniqueness across the *whole* pipeline is the one thing the scratch
    // pipeline cannot know about. Checked before anything is claimed, so a
    // rejected group leaves the builder untouched.
    for (const name of names) {
      this.assertNameFree(name);
    }
    for (const name of names) {
      this.names.add(name);
    }
    this.entries.push(
      options?.concurrency === undefined
        ? { kind: 'parallel', steps }
        : { kind: 'parallel', steps, concurrency: options.concurrency },
    );
    this.built = undefined;
    return this;
  }

  compose(name: string, inner: ComposeTarget, options: ComposeOptions): this {
    const target = inner instanceof Pipeline ? inner : inner.toPipeline();
    const mapResult = options.mapResult;
    if (mapResult === undefined) {
      // Nothing to contribute, so the inner run needs no result captured.
      const plain = target.asStep<ErasedCtx>(name, {
        mapInput: options.mapInput,
      });
      return this.pushSpec({
        name,
        run: async (ctx, meta) => {
          await plain.run(ctx, meta);
        },
      });
    }
    // `asStep` calls its own mapResult synchronously and never awaits it, so
    // merging inside it would silently drop an async mapResult's contribution.
    // It is used only to capture the inner Result; the typed mapResult is then
    // awaited below and its value RETURNED, so the ordinary merge wrapper
    // handles it — one merge path, and the reserved-key guards cover compose
    // for free. Keyed by the outer context, so concurrent runs never share.
    const captured = new WeakMap<BaseContext, Result<ErasedCtx>>();
    const capturing = target.asStep<ErasedCtx>(name, {
      mapInput: options.mapInput,
      mapResult: (innerResult, outerCtx) => {
        captured.set(outerCtx, innerResult);
      },
    });
    return this.pushSpec({
      name,
      run: async (ctx, meta) => {
        // Throws on inner failure, so reaching the next line means the inner
        // pipeline succeeded and its mapResult above has run.
        await capturing.run(ctx, meta);
        const innerResult = captured.get(ctx)!;
        captured.delete(ctx);
        return await mapResult(innerResult, ctx);
      },
    });
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

  /** Registers a sequential step, claiming its name first. */
  private pushSpec(spec: StepSpec): this {
    assertSafeName('Step', spec.name);
    this.assertNameFree(spec.name);
    this.names.add(spec.name);
    this.entries.push({ kind: 'sequential', spec });
    this.built = undefined;
    return this;
  }

  private assertNameFree(name: string): void {
    if (this.names.has(name)) {
      throw new UsageError(
        `Pipeline "${this.pipelineName}" already has a step named "${name}". Step ` +
          `names must be unique across the whole pipeline, so rename this one or the earlier one.`,
      );
    }
  }

  /**
   * Returns the step a modifier applies to — always the most recently declared
   * one — and invalidates the memoised build. Applying the same modifier twice
   * **replaces** the earlier value rather than combining or throwing, mirroring
   * `Step.prototype.when`.
   *
   * Two shapes are misuse and fail fast (0.5.0 spec, section 3.5): a modifier
   * with no step to attach to, and a modifier aimed at a parallel group, whose
   * members are configured on their own definitions instead.
   */
  private modify(modifier: string): StepSpec {
    const entry = this.entries[this.entries.length - 1];
    if (entry === undefined) {
      throw new UsageError(
        `Pipeline "${this.pipelineName}" .${modifier}() must follow a step. ` +
          `Add a step with .step(name, run) first; modifiers apply to the most ` +
          `recent step.`,
      );
    }
    if (entry.kind !== 'sequential') {
      throw new UsageError(
        `Pipeline "${this.pipelineName}" .${modifier}() cannot modify a ` +
          `parallel group, because a modifier targets a single step. Apply it ` +
          `to the StepDef instead, before passing it to .parallel().`,
      );
    }
    this.built = undefined;
    return entry.spec;
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
    for (const entry of this.entries) {
      if (entry.kind === 'sequential') {
        pipeline.addStep(toStep(entry.spec));
      } else if (entry.concurrency === undefined) {
        pipeline.addParallel(entry.steps);
      } else {
        pipeline.addParallel(entry.steps, { concurrency: entry.concurrency });
      }
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

/* eslint-disable @typescript-eslint/no-empty-object-type --
 * `{}` is the empty starting state: a pipeline that has produced nothing yet.
 * It is the identity element of `Merge`, which no other type provides. See the
 * note in ./types.ts.
 */

/**
 * Starts a typed pipeline. Each `.step()` declares
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
 *
 * @param name - Name for the pipeline. Appears in `result.pipelineName`, in
 * log lines, and in the pipeline's trace span. Must be a non-empty string and
 * not one of the reserved names `__proto__`, `prototype`, or `constructor`.
 */
export function pipeline<TInput>(name: string): TypedPipeline<TInput, {}, {}> {
  return new TypedPipelineBuilder(name) as unknown as TypedPipeline<
    TInput,
    {},
    {}
  >;
}

/* eslint-enable @typescript-eslint/no-empty-object-type */
