// Order-processing example. Run it with: npm run example:order
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { Engine, Pipeline, Step } from 'penstock';
import { Engine, Pipeline, Step } from '../src/index.js';
import type { BaseContext } from '../src/index.js';

interface LineItem {
  sku: string;
  price: number;
  qty: number;
}

interface OrderInput {
  items: LineItem[];
  customer: { id: string; tier: 'standard' | 'premium' };
  // A flag the example flips to force a late failure and demonstrate rollback.
  failOnShip?: boolean;
}

// Mid-run fields are optional: they don't exist until the step that sets them.
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string;
  subtotal?: number;
  total?: number;
}

// An engine is a reusable bundle of domain functions, called by steps.
const pricingEngine = new Engine('pricing', {
  subtotal(order: OrderInput): number {
    return order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  },
});

const validateOrder = new Step<OrderCtx>('validate-order', (ctx) => {
  if (ctx.input.items.length === 0) {
    throw new Error('Order has no items');
  }
});

const reserveInventory = new Step<OrderCtx>('reserve-inventory', {
  run: (ctx) => {
    ctx.reservationId = `rsv_${ctx.input.customer.id}`;
    console.log(`  reserved inventory → ${ctx.reservationId}`);
  },
  // Compensation: if a later step fails, the reservation is released.
  undo: (ctx) => {
    console.log(`  ↩ released inventory ${ctx.reservationId}`);
  },
});

const calculateTotal = new Step<OrderCtx>('calculate-total', (ctx) => {
  // Engine methods are typed as returning `unknown`; cast at the call site.
  ctx.subtotal = ctx.engines.pricing.subtotal(ctx.input) as number;
  ctx.total = ctx.subtotal;
});

const applyPremiumDiscount = new Step<OrderCtx>('apply-premium-discount', {
  run: (ctx) => {
    ctx.total = Math.round((ctx.total ?? 0) * 0.9 * 100) / 100;
    console.log('  applied 10% premium discount');
  },
  // Guard: only premium customers reach this step.
  when: (ctx) => ctx.input.customer.tier === 'premium',
});

const shipOrder = new Step<OrderCtx>('ship-order', {
  run: (ctx) => {
    if (ctx.input.failOnShip) {
      throw new Error('Carrier rejected the shipment');
    }
    console.log('  shipment booked');
  },
  // No undo: an unbooked shipment needs no compensation.
});

const orderPipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validateOrder)
  .addStep(reserveInventory)
  .addStep(calculateTotal)
  .addStep(applyPremiumDiscount)
  .addStep(shipOrder)
  .useEngine(pricingEngine);

const baseOrder: OrderInput = {
  items: [
    { sku: 'A-1', price: 1000, qty: 2 },
    { sku: 'B-2', price: 500, qty: 1 },
  ],
  customer: { id: 'cust_42', tier: 'premium' },
};

const statuses = (steps: { name: string; status: string }[]): string =>
  steps.map((s) => `${s.name}:${s.status}`).join(', ');

console.log('▶ successful order');
const ok = await orderPipeline.execute(baseOrder);
console.log('  ok:', ok.ok, '| total:', ok.context.total);
console.log('  steps:', statuses(ok.steps));

console.log('\n▶ order that fails at shipping (triggers rollback)');
const failed = await orderPipeline.execute({ ...baseOrder, failOnShip: true });
console.log('  ok:', failed.ok);
console.log('  error:', failed.error?.message);
console.log('  steps:', statuses(failed.steps));
console.log('  rollbackErrors:', failed.rollbackErrors);
