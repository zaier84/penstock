import { describe, expectTypeOf, it } from 'vitest';

import type { BaseContext, Result } from '../src/index';
import { Pipeline, Step } from '../src/index';

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
      // Cancellation/timeout signal is always present and non-optional (section 1.5).
      expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
      // @ts-expect-error — fields not declared on OrderCtx do not exist.
      void ctx.nonexistent;
    });
  });

  it('types the execute Result by the pipeline context', async () => {
    const result = await new Pipeline<OrderCtx>('p').execute({ items: [] });
    expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();
    expectTypeOf(result.context.total).toEqualTypeOf<number | undefined>();
    // Non-optional on every Result (0.3.0 spec, section 1.3.3).
    expectTypeOf(result.aborted).toEqualTypeOf<boolean>();
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
});
