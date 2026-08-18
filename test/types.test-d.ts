import { describe, expectTypeOf, it } from 'vitest';

import type {
  BaseContext,
  ExecuteOptions,
  GuardFn,
  LifecycleCallback,
  ParallelOptions,
  Result,
  RunFn,
  SerializeOptions,
  SerializedError,
  SerializedResult,
  SerializedStepReport,
  StepMeta,
  TraceSpan,
  Tracer,
  UndoFn,
} from '../src/index';
import {
  defineStep,
  Pipeline,
  pipeline,
  serializeResult,
  Step,
} from '../src/index';
import type {
  Merge,
  ProducesOf,
  RequiresOf,
  StateOf,
  TypedCtx,
} from '../src/index';
import { otelTracer } from '../src/otel/index';
import type { OtelTracerOptions } from '../src/otel/index';

interface OrderInput {
  items: { price: number; qty: number }[];
}

// A user context extending BaseContext: mid-run fields are optional because they
// do not exist until the step that populates them runs (section 3.3).
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string;
  total?: number;
}

describe('generic context inference (section 3.3)', () => {
  it('types ctx fields inside a step run', () => {
    new Step<OrderCtx>('calc', (ctx) => {
      expectTypeOf(ctx.input).toEqualTypeOf<OrderInput>();
      expectTypeOf(ctx.total).toEqualTypeOf<number | undefined>();
      expectTypeOf(ctx.reservationId).toEqualTypeOf<string | undefined>();
      // Pipeline-level cancellation signal, always present (0.4.0 section 1.3).
      expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
      // Execution identity, always present (0.4.0 section 1.1).
      expectTypeOf(ctx.executionId).toEqualTypeOf<string>();
      // @ts-expect-error — fields not declared on OrderCtx do not exist.
      void ctx.nonexistent;
    });
  });

  it('types the StepMeta handed to run and undo (0.4.0 section 1.2)', () => {
    new Step<OrderCtx>('charge', {
      run: (ctx, meta) => {
        expectTypeOf(ctx).toEqualTypeOf<OrderCtx>();
        expectTypeOf(meta).toEqualTypeOf<StepMeta>();
        expectTypeOf(meta.stepName).toEqualTypeOf<string>();
        expectTypeOf(meta.attempt).toEqualTypeOf<number>();
        expectTypeOf(meta.idempotencyKey).toEqualTypeOf<string>();
        expectTypeOf(meta.signal).toEqualTypeOf<AbortSignal>();
      },
      undo: (_ctx, meta) => {
        expectTypeOf(meta).toEqualTypeOf<StepMeta>();
      },
      when: (ctx) => ctx.input.items.length > 0,
    });

    // Guards stay single-argument pure predicates (0.4.0 section 1.2): handing
    // them an attempt number or an idempotency key would invite side effects.
    expectTypeOf<Parameters<GuardFn<OrderCtx>>['length']>().toEqualTypeOf<1>();
    expectTypeOf<Parameters<RunFn<OrderCtx>>['length']>().toEqualTypeOf<2>();
    expectTypeOf<Parameters<UndoFn<OrderCtx>>['length']>().toEqualTypeOf<2>();

    // Declaring fewer parameters stays valid — no arity break for 0.3.x code.
    const legacy: RunFn<OrderCtx> = (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<OrderCtx>();
    };
    new Step<OrderCtx>('legacy', legacy);
  });

  it('types the idempotencyKey option by the step context (0.4.0 section 1.4)', () => {
    new Step<OrderCtx>('charge', {
      run: () => {},
      idempotencyKey: (ctx) => `charge:${ctx.input.items.length}`,
    });
    new Step<OrderCtx>('charge-fixed', {
      run: () => {},
      idempotencyKey: 'literal',
    });
    new Step<OrderCtx>('charge-bad', {
      run: () => {},
      // @ts-expect-error — the key must be a string or a function returning one.
      idempotencyKey: 42,
    });
  });

  it('types the addParallel options (0.4.0 section 1.5)', () => {
    const bounded = new Pipeline<OrderCtx>('p').addParallel(
      [new Step<OrderCtx>('a', () => {}), new Step<OrderCtx>('b', () => {})],
      { concurrency: 2 },
    );
    // Chainable, exactly like the no-options form.
    expectTypeOf(bounded).toEqualTypeOf<Pipeline<OrderCtx>>();
    expectTypeOf<ParallelOptions['concurrency']>().toEqualTypeOf<
      number | undefined
    >();

    new Pipeline<OrderCtx>('p2').addParallel(
      [new Step<OrderCtx>('a', () => {}), new Step<OrderCtx>('b', () => {})],
      // @ts-expect-error — the limit is a number of steps, not a string.
      { concurrency: '2' },
    );
  });

  it('types the execute Result by the pipeline context', async () => {
    const result = await new Pipeline<OrderCtx>('p').execute({ items: [] });
    expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();
    expectTypeOf(result.context.total).toEqualTypeOf<number | undefined>();
    // Non-optional on every Result (0.3.0 spec, section 1.3.3).
    expectTypeOf(result.aborted).toEqualTypeOf<boolean>();
    // Required identity and timing fields (0.4.0 spec, sections 1.1 and 1.7).
    expectTypeOf(result.executionId).toEqualTypeOf<string>();
    expectTypeOf(result.pipelineName).toEqualTypeOf<string>();
    expectTypeOf(result.durationMs).toEqualTypeOf<number>();
    expectTypeOf(result.steps[0]?.idempotencyKey).toEqualTypeOf<
      string | undefined
    >();
  });

  it('types serializeResult and its output (0.4.0 section 1.6)', async () => {
    const result = await new Pipeline<OrderCtx>('p').execute({ items: [] });
    const serialized = serializeResult(result);

    expectTypeOf(serialized).toEqualTypeOf<SerializedResult>();
    expectTypeOf(serialized.error).toEqualTypeOf<SerializedError | null>();
    expectTypeOf(serialized.rollbackErrors).toEqualTypeOf<SerializedError[]>();
    expectTypeOf(serialized.steps).toEqualTypeOf<SerializedStepReport[]>();
    // Opaque by design: the caller opted in and knows their own context.
    expectTypeOf(serialized.context).toEqualTypeOf<unknown>();
    expectTypeOf(serialized.steps[0]?.innerResult).toEqualTypeOf<
      SerializedResult | undefined
    >();
    // Custom error fields are reachable, untyped, through the index signature.
    expectTypeOf(serialized.error?.stepName).toEqualTypeOf<unknown>();
    expectTypeOf<SerializeOptions['includeContext']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<SerializeOptions['maxCauseDepth']>().toEqualTypeOf<
      number | undefined
    >();

    serializeResult(result, {
      // @ts-expect-error — the options are the documented three, nothing else.
      includeSecrets: true,
    });
  });

  it('types the tracer surface and its execute options (0.4.0 sections 1.8 and 1.9)', async () => {
    const span: TraceSpan = {
      setAttribute(key, value) {
        expectTypeOf(key).toEqualTypeOf<string>();
        expectTypeOf(value).toEqualTypeOf<string | number | boolean>();
      },
      recordException(error) {
        // Deliberately `unknown`: a step may throw anything at all.
        expectTypeOf(error).toEqualTypeOf<unknown>();
      },
      setStatus(status, message) {
        expectTypeOf(status).toEqualTypeOf<'ok' | 'error'>();
        expectTypeOf(message).toEqualTypeOf<string | undefined>();
      },
      end() {},
    };
    const tracer: Tracer = {
      startSpan(name, parent) {
        expectTypeOf(name).toEqualTypeOf<string>();
        expectTypeOf(parent).toEqualTypeOf<TraceSpan | undefined>();
        return span;
      },
    };

    expectTypeOf<ExecuteOptions['tracer']>().toEqualTypeOf<
      Tracer | undefined
    >();
    expectTypeOf<ExecuteOptions['parentSpan']>().toEqualTypeOf<
      TraceSpan | undefined
    >();
    const result = await new Pipeline<OrderCtx>('p').execute(
      { items: [] },
      { tracer, parentSpan: span },
    );
    expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();

    new Pipeline<OrderCtx>('p2').execute(
      { items: [] },
      // @ts-expect-error — a tracer must implement startSpan.
      { tracer: {} },
    );
  });

  it('types the penstock/otel adapter as a core Tracer (0.4.0 section 1.9)', () => {
    expectTypeOf(otelTracer()).toEqualTypeOf<Tracer>();
    expectTypeOf(
      otelTracer({ name: 'app', version: '1.0.0' }),
    ).toEqualTypeOf<Tracer>();
    expectTypeOf<OtelTracerOptions['name']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<OtelTracerOptions['version']>().toEqualTypeOf<
      string | undefined
    >();
    // @ts-expect-error — the options are the documented two, nothing else.
    otelTracer({ endpoint: 'http://localhost:4318' });
  });

  it('types asStep by the outer context and the inner input (0.3.0 section 1.2)', () => {
    interface InvInput {
      skus: string[];
    }
    type InvCtx = BaseContext<InvInput>;
    const inner = new Pipeline<InvCtx>('inventory');

    const wrapped = inner.asStep<OrderCtx>('run-inventory', {
      // mapInput sees the OUTER context and must return the INNER input.
      mapInput: (outer) => ({ skus: outer.input.items.map(() => 'sku') }),
      mapResult: (_innerResult, outer) => {
        expectTypeOf(outer).toEqualTypeOf<OrderCtx>();
      },
      undo: (outer) => {
        expectTypeOf(outer).toEqualTypeOf<OrderCtx>();
      },
    });
    expectTypeOf(wrapped).toEqualTypeOf<Step<OrderCtx>>();

    inner.asStep<OrderCtx>('bad-wrap', {
      // @ts-expect-error — mapInput must return the inner pipeline's input.
      mapInput: () => ({ wrong: true }),
    });
  });

  it('types lifecycle callbacks by the pipeline context (0.3.0 section 1.3)', () => {
    const chained: Pipeline<OrderCtx> = new Pipeline<OrderCtx>('p')
      .onComplete((result) => {
        expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();
      })
      .onFailure((result) => {
        expectTypeOf(result.aborted).toEqualTypeOf<boolean>();
      })
      .onCancel(async (result) => {
        expectTypeOf(result.error).toEqualTypeOf<Error | null>();
      })
      .onSettled((result) => {
        expectTypeOf(result.context.total).toEqualTypeOf<number | undefined>();
      });
    expectTypeOf(chained).toEqualTypeOf<Pipeline<OrderCtx>>();

    // The exported callback type matches what the registration methods take.
    const cb: LifecycleCallback<OrderCtx> = (result) => {
      expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();
    };
    new Pipeline<OrderCtx>('p2').onSettled(cb);
  });
});

// ---------------------------------------------------------------------------
// 0.5.0 typed builder. Each step declares what it produces and the context type
// accumulates down the chain, so a key is required from the moment its step has
// run -- which is what removes the ctx.reservationId! the class API forces.
// ---------------------------------------------------------------------------

interface CheckoutInput {
  items: { sku: string; qty: number }[];
  card: string;
}

// An INTERFACE return type. Interfaces have no implicit index signature, so
// this is not assignable to Record<string, unknown> -- which is exactly why the
// step-return constraint is `object` (0.5.0 section 2.1).
interface Reservation {
  reservationId: string;
  warehouse: string;
}

declare function reserve(
  items: CheckoutInput['items'],
  key: string,
): Promise<Reservation>;
declare function release(reservationId: string): Promise<void>;
declare function charge(card: string, reservationId: string): Promise<string>;

describe('typed builder type primitives (0.5.0 section 2.2)', () => {
  it('normalises a run return into a state contribution', () => {
    expectTypeOf<StateOf<{ a: string }>>().toEqualTypeOf<{ a: string }>();
    expectTypeOf<StateOf<Reservation>>().toEqualTypeOf<Reservation>();
    // A void or undefined return contributes nothing, so it is the identity
    // element of Merge -- asserted through Merge to avoid spelling the empty
    // object type here.
    expectTypeOf<Merge<{ a: string }, StateOf<void>>>().toEqualTypeOf<{
      a: string;
    }>();
    expectTypeOf<Merge<{ a: string }, StateOf<undefined>>>().toEqualTypeOf<{
      a: string;
    }>();
  });

  it('merges later keys over earlier ones, matching the runtime write order', () => {
    expectTypeOf<
      Merge<{ a: string; v: string }, { v: number }>
    >().toEqualTypeOf<{
      a: string;
      v: number;
    }>();
  });

  it('composes the context from BaseContext plus the accumulated state', () => {
    expectTypeOf<TypedCtx<CheckoutInput, { total: number }>>().toEqualTypeOf<
      BaseContext<CheckoutInput> & { total: number }
    >();
  });
});

describe('typed builder inference (0.5.0 sections 2.3 and 2.4)', () => {
  it('accumulates every contribution down the chain (section 2.6)', async () => {
    const checkout = pipeline<CheckoutInput>('checkout')
      .step('validate', (ctx) => {
        expectTypeOf(ctx.input).toEqualTypeOf<CheckoutInput>();
        expectTypeOf(ctx.executionId).toEqualTypeOf<string>();
        if (!ctx.input.items.length) throw new Error('empty order');
      })
      .step('reserve', async (ctx, meta): Promise<Reservation> => {
        expectTypeOf(meta).toEqualTypeOf<StepMeta>();
        return reserve(ctx.input.items, meta.idempotencyKey);
      })
      // Sees its own output as REQUIRED: a compensation only ever runs for a
      // step that completed. No non-null assertion anywhere in this chain.
      .undo(async (ctx) => release(ctx.reservationId))
      .retry({ attempts: 3, backoff: 'exponential' })
      .step('charge', async (ctx) => {
        expectTypeOf(ctx.reservationId).toEqualTypeOf<string>();
        expectTypeOf(ctx.warehouse).toEqualTypeOf<string>();
        return { chargeId: await charge(ctx.input.card, ctx.reservationId) };
      })
      .step('discount', async () => ({ discountCode: 'SAVE10' }))
      .when((ctx) => ctx.input.items.length > 3)
      .step('audit', (ctx) => {
        expectTypeOf(ctx.chargeId).toEqualTypeOf<string>();
        expectTypeOf(ctx.warehouse).toEqualTypeOf<string>();
        // Guarded, so it may legitimately be absent by the time this runs.
        expectTypeOf(ctx.discountCode).toEqualTypeOf<string | undefined>();
      });

    const result = await checkout.execute({ items: [], card: 'tok_1' });
    expectTypeOf(result.context.chargeId).toEqualTypeOf<string>();
    expectTypeOf(result.context.discountCode).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(result.executionId).toEqualTypeOf<string>();
    expectTypeOf(result.aborted).toEqualTypeOf<boolean>();
  });

  it('splits the last contribution out so when and idempotencyKey see only TPrev', () => {
    pipeline<CheckoutInput>('split')
      .step('a', () => ({ orderId: 'o1' }))
      .step('b', () => ({ chargeId: 'c1' }))
      // Both are evaluated BEFORE their step runs, so its own output is not
      // yet in scope -- which is exactly what the TPrev / TLast split buys.
      .idempotencyKey((ctx) => {
        expectTypeOf(ctx.orderId).toEqualTypeOf<string>();
        // @ts-expect-error — chargeId is this very step's own output.
        void ctx.chargeId;
        return 'charge:' + ctx.orderId;
      })
      .when((ctx) => {
        expectTypeOf(ctx.orderId).toEqualTypeOf<string>();
        return true;
      });
  });

  it('types toPipeline and execute by the accumulated state', () => {
    const built = pipeline<CheckoutInput>('escape')
      .step('a', () => ({ token: 'x' }))
      .toPipeline();
    expectTypeOf(built).toEqualTypeOf<
      Pipeline<TypedCtx<CheckoutInput, { token: string }>>
    >();
    expectTypeOf(pipeline<CheckoutInput>('opts').execute)
      .parameter(1)
      .toEqualTypeOf<ExecuteOptions | undefined>();
  });

  it('shows observers a partial state and lifecycle callbacks the full one', () => {
    pipeline<CheckoutInput>('observers')
      .step('a', () => ({ token: 'x' }))
      .before((ctx) => {
        // `before` fires for EVERY step, so at any given firing only part of
        // the state exists. Partial is type-honest, not pessimistic.
        expectTypeOf(ctx.token).toEqualTypeOf<string | undefined>();
      })
      .after((ctx) => {
        expectTypeOf(ctx.token).toEqualTypeOf<string | undefined>();
      })
      .onError((error, ctx) => {
        expectTypeOf(error).toEqualTypeOf<Error>();
        expectTypeOf(ctx.token).toEqualTypeOf<string | undefined>();
      })
      // Lifecycle callbacks fire once, at the end, so they see the full state.
      .onComplete((result) => {
        expectTypeOf(result.context.token).toEqualTypeOf<string>();
      })
      .onSettled((result) => {
        expectTypeOf(result.context.token).toEqualTypeOf<string>();
      });
  });

  it('rejects a key no earlier step has produced', () => {
    pipeline<CheckoutInput>('n1').step('a', (ctx) => {
      // @ts-expect-error — reservationId is produced by no earlier step.
      void ctx.reservationId;
    });
  });

  it('rejects a produced key read at the wrong type', () => {
    pipeline<CheckoutInput>('n2')
      .step('a', () => ({ x: 1 }))
      .step('b', (ctx) => {
        // @ts-expect-error — x is a number, not a string.
        const s: string = ctx.x;
        void s;
      });
  });

  it('rejects treating a guarded contribution as required', () => {
    pipeline<CheckoutInput>('n3')
      .step('a', () => ({ y: 1 }))
      .when(() => true)
      .step('b', (ctx) => {
        // @ts-expect-error — a guarded step's output is optional.
        const n: number = ctx.y;
        void n;
      });
  });

  it('rejects an undo reading a key its step did not produce', () => {
    pipeline<CheckoutInput>('n4')
      .step('a', () => ({ z: 1 }))
      .undo((ctx) => {
        // @ts-expect-error — nope is not a produced key.
        void ctx.nope;
      });
  });

  it('rejects a modifier argument of the wrong shape', () => {
    pipeline<CheckoutInput>('n5')
      .step('a', () => ({ z: 1 }))
      // @ts-expect-error — timeout is a number of milliseconds.
      .timeout('1000');
  });
});

describe('defineStep inference (0.5.0 section 2.5)', () => {
  const forCheckout = defineStep<CheckoutInput>();

  it('infers what a definition produces and requires', () => {
    const fetchUser = forCheckout('fetch-user', async () => ({
      user: { id: 'u1' },
    }));

    // A definition carries its name and its constructed Step at runtime, and
    // its requires/produces only in the type system.
    expectTypeOf(fetchUser.name).toEqualTypeOf<string>();
    expectTypeOf<ProducesOf<typeof fetchUser>>().toEqualTypeOf<{
      user: { id: string };
    }>();
    // No declared requirement, so it is the identity element of Merge.
    expectTypeOf<
      Merge<{ a: string }, RequiresOf<typeof fetchUser>>
    >().toEqualTypeOf<{ a: string }>();
  });

  it('types the run context by the declared requirement', () => {
    defineStep<CheckoutInput, { token: string }>()('call-api', (ctx) => {
      expectTypeOf(ctx.input).toEqualTypeOf<CheckoutInput>();
      expectTypeOf(ctx.token).toEqualTypeOf<string>();
      return { profile: 'p' };
    });
  });

  it('accepts a definition whose requirement an earlier step satisfies', () => {
    const needsToken = defineStep<CheckoutInput, { token: string }>()(
      'call-api',
      (ctx) => ({ profile: 'p:' + ctx.token }),
    );

    pipeline<CheckoutInput>('satisfied')
      .step('auth', () => ({ token: 'tok' }))
      .use(needsToken)
      .step('after', (ctx) => {
        expectTypeOf(ctx.token).toEqualTypeOf<string>();
        expectTypeOf(ctx.profile).toEqualTypeOf<string>();
      });
  });

  it('rejects a definition used before its requirement is produced', () => {
    const needsToken = defineStep<CheckoutInput, { token: string }>()(
      'call-api',
      (ctx) => ({ profile: 'p:' + ctx.token }),
    );

    pipeline<CheckoutInput>('unsatisfied')
      // @ts-expect-error — token is produced by no earlier step.
      .use(needsToken);

    pipeline<CheckoutInput>('wrong-type')
      .step('auth', () => ({ token: 42 }))
      // @ts-expect-error — token is a number here, not the string required.
      .use(needsToken);
  });

  it('makes a guarded definition contribution optional', () => {
    pipeline<CheckoutInput>('guarded-def')
      .use(forCheckout('maybe', () => ({ flag: true })).when(() => false))
      .step('after', (ctx) => {
        expectTypeOf(ctx.flag).toEqualTypeOf<boolean | undefined>();
      });
  });

  it('intersects the contributions of a parallel group', () => {
    pipeline<CheckoutInput>('fanout')
      .parallel(
        [
          forCheckout('a', () => ({ user: 'u' })),
          forCheckout('b', async () => ({ price: 1 })),
        ],
        { concurrency: 2 },
      )
      .step('after', (ctx) => {
        expectTypeOf(ctx.user).toEqualTypeOf<string>();
        expectTypeOf(ctx.price).toEqualTypeOf<number>();
      });
  });
});

describe('typed composition inference (0.5.0 section 2.4)', () => {
  interface SkuInput {
    sku: string;
  }
  const inner = pipeline<SkuInput>('inner').step('lookup', (ctx) => ({
    stock: 7,
    sku: ctx.input.sku,
  }));

  it('types compose by what its mapResult returns', () => {
    pipeline<CheckoutInput>('outer')
      .compose('inventory', inner, {
        mapInput: (ctx) => {
          expectTypeOf(ctx.input).toEqualTypeOf<CheckoutInput>();
          return { sku: 'sku_1' };
        },
        mapResult: (result, ctx) => {
          // The inner Result is typed by the inner pipeline's accumulated state.
          expectTypeOf(result.context.stock).toEqualTypeOf<number>();
          expectTypeOf(result.context.sku).toEqualTypeOf<string>();
          expectTypeOf(ctx.input).toEqualTypeOf<CheckoutInput>();
          return { stock: result.context.stock };
        },
      })
      .step('after', (ctx) => {
        expectTypeOf(ctx.stock).toEqualTypeOf<number>();
      });
  });

  it('follows an async mapResult through Awaited', () => {
    pipeline<CheckoutInput>('outer-async')
      .compose('inventory', inner, {
        mapInput: () => ({ sku: 'sku_1' }),
        mapResult: async (result) => ({ doubled: result.context.stock * 2 }),
      })
      .step('after', (ctx) => {
        expectTypeOf(ctx.doubled).toEqualTypeOf<number>();
      });
  });

  it('contributes nothing when compose has no mapResult', () => {
    pipeline<CheckoutInput>('outer-none')
      .step('a', () => ({ a: 1 }))
      .compose('inventory', inner, { mapInput: () => ({ sku: 'sku_1' }) })
      .step('after', (ctx) => {
        expectTypeOf(ctx.a).toEqualTypeOf<number>();
        // @ts-expect-error — no mapResult, so the compose contributed nothing.
        void ctx.stock;
      });
  });

  it('rejects a mapInput returning the wrong inner input', () => {
    pipeline<CheckoutInput>('outer-bad')
      // @ts-expect-error — the inner pipeline takes { sku: string }, so no
      // overload matches; the error lands on the call, not the property.
      .compose('inventory', inner, {
        mapInput: () => ({ wrong: true }),
      });
  });

  it('accepts a class-API Pipeline as the inner pipeline', () => {
    type InvCtx = BaseContext<SkuInput> & { stock?: number };
    const legacy = new Pipeline<InvCtx>('legacy');

    pipeline<CheckoutInput>('outer-legacy')
      .compose('legacy', legacy, {
        mapInput: () => ({ sku: 'sku_1' }),
        mapResult: (result) => {
          expectTypeOf(result.context.stock).toEqualTypeOf<
            number | undefined
          >();
          return { stock: result.context.stock ?? 0 };
        },
      })
      .step('after', (ctx) => {
        expectTypeOf(ctx.stock).toEqualTypeOf<number>();
      });
  });
});
