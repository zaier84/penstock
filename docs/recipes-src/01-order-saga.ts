// Runnable against the local source. Published code imports from 'penstock'.
import { pipeline } from '../../src/index.js';

interface OrderInput {
  orderId: string;
  customerId: string;
  items: { sku: string; qty: number; price: number }[];
  card: string;
  failAt?: 'charge' | 'ship';
}

// ── Stub services, standing in for four real systems ────────────────────────
const state = { reserved: new Set<string>(), charges: new Set<string>(), shipments: new Set<string>() };

const inventory = {
  async reserve(orderId: string) {
    const id = `rsv_${orderId}`;
    state.reserved.add(id);
    return id;
  },
  async release(id: string) {
    state.reserved.delete(id);
    console.log(`  [inventory] released ${id}`);
  },
};
const payments = {
  async charge(card: string, amount: number, orderId: string, fail: boolean) {
    if (fail) throw new Error('card declined');
    const id = `chg_${orderId}_${amount}`;
    state.charges.add(id);
    return id;
  },
  async refund(id: string) {
    state.charges.delete(id);
    console.log(`  [payments] refunded ${id}`);
  },
};
const shipping = {
  async book(orderId: string, fail: boolean) {
    if (fail) throw new Error('no carrier available');
    const id = `shp_${orderId}`;
    state.shipments.add(id);
    return id;
  },
  async cancel(id: string) {
    state.shipments.delete(id);
    console.log(`  [shipping] cancelled ${id}`);
  },
};
const notifications = {
  async send(customerId: string, shipmentId: string) {
    console.log(`  [notify] told ${customerId} about ${shipmentId}`);
  },
};

// ── The saga ────────────────────────────────────────────────────────────────
const checkout = pipeline<OrderInput>('checkout')
  .step('validate-order', (ctx) => {
    if (ctx.input.items.length === 0) throw new Error('order has no items');
    const total = ctx.input.items.reduce((s, i) => s + i.price * i.qty, 0);
    return { total };
  })
  .step('reserve-stock', async (ctx) => ({
    reservationId: await inventory.reserve(ctx.input.orderId),
  }))
  .undo(async (ctx) => inventory.release(ctx.reservationId))
  .retry({ attempts: 3, delayMs: 50, backoff: 'exponential' })
  .step('charge-card', async (ctx) => ({
    chargeId: await payments.charge(
      ctx.input.card,
      ctx.total,
      ctx.input.orderId,
      ctx.input.failAt === 'charge',
    ),
  }))
  .undo(async (ctx) => payments.refund(ctx.chargeId))
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}`)
  .step('book-shipment', async (ctx) => ({
    shipmentId: await shipping.book(ctx.input.orderId, ctx.input.failAt === 'ship'),
  }))
  .undo(async (ctx) => shipping.cancel(ctx.shipmentId))
  .step('notify-customer', async (ctx) => {
    await notifications.send(ctx.input.customerId, ctx.shipmentId);
  })
  .onSettled((r) => console.log(`  [audit] ${r.pipelineName} ok=${r.ok}`));

const order: OrderInput = {
  orderId: 'ord_1001',
  customerId: 'cust_42',
  items: [{ sku: 'A-1', qty: 2, price: 1500 }],
  card: 'tok_visa',
};

const show = (r: Awaited<ReturnType<typeof checkout.execute>>) => {
  console.log(`ok: ${r.ok}${r.error ? ` | error: ${r.error.message}` : ''}`);
  for (const s of r.steps) console.log(`  ${s.name.padEnd(15)} ${s.status}`);
  console.log(`left behind -> reserved:${state.reserved.size} charges:${state.charges.size} shipments:${state.shipments.size}`);
  console.log();
};

const reset = () => {
  state.reserved.clear();
  state.charges.clear();
  state.shipments.clear();
};

console.log('=== happy path ===');
reset();
show(await checkout.execute(order));

console.log('=== shipping fails after the card was charged ===');
reset();
show(await checkout.execute({ ...order, orderId: 'ord_1002', failAt: 'ship' }));

console.log('=== the card is declined ===');
reset();
show(await checkout.execute({ ...order, orderId: 'ord_1003', failAt: 'charge' }));
