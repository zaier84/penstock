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
import { Pipeline, serializeResult, Step } from '../src/index';
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
