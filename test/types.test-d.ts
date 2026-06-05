import { describe, expectTypeOf, it } from 'vitest';

import type { BaseContext, Result } from '../src/index';
import { Pipeline, Step } from '../src/index';

interface OrderInput {
  items: { price: number; qty: number }[];
}

// A user context extending BaseContext: mid-run fields are optional because they
// do not exist until the step that populates them runs (§3.3).
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string;
  total?: number;
}

describe('generic context inference (§3.3)', () => {
  it('types ctx fields inside a step run', () => {
    new Step<OrderCtx>('calc', (ctx) => {
      expectTypeOf(ctx.input).toEqualTypeOf<OrderInput>();
      expectTypeOf(ctx.total).toEqualTypeOf<number | undefined>();
      expectTypeOf(ctx.reservationId).toEqualTypeOf<string | undefined>();
      // @ts-expect-error — fields not declared on OrderCtx do not exist.
      void ctx.nonexistent;
    });
  });

  it('types the execute Result by the pipeline context', async () => {
    const result = await new Pipeline<OrderCtx>('p').execute({ items: [] });
    expectTypeOf(result).toEqualTypeOf<Result<OrderCtx>>();
    expectTypeOf(result.context.total).toEqualTypeOf<number | undefined>();
  });
});
