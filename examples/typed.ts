// Typed builder example. Run it with: npm run example:typed
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { defineStep, pipeline, serializeResult } from 'penstock';
//
// It exists to show one thing: every step declares what it PRODUCES, and the
// context type accumulates down the chain. A key is required from the moment
// its step has run — so there is not a single `!` anywhere below, and reading
// a key before the step that produces it would not compile.
import { defineStep, pipeline, serializeResult } from '../src/index.js';

interface OrderInput {
  orderId: string;
  items: { sku: string; qty: number }[];
  card: string;
  failOnShip: boolean;
}

// An INTERFACE return type. Interfaces have no implicit index signature, so
// this is not assignable to Record<string, unknown> — which is exactly why a
// step's return is constrained to `object` and not to a record type.
interface Reservation {
  reservationId: string;
  warehouse: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let runStartedAt = performance.now();
const at = (): string =>
  `t+${String(Math.round(performance.now() - runStartedAt)).padStart(3, ' ')}ms`;

// ---------------------------------------------------------------------------
// Stand-in services.
// ---------------------------------------------------------------------------

let reserveCalls = 0;

async function reserve(items: OrderInput['items']): Promise<Reservation> {
  reserveCalls += 1;
  // Flaky on the very first call of the process, so the retry is visible.
  if (reserveCalls === 1) throw new Error('warehouse timed out');
  await sleep(5);
  return { reservationId: `rsv_${String(items.length)}`, warehouse: 'LHR' };
}

async function release(reservationId: string): Promise<void> {
  await sleep(5);
  console.log(`    ↩ released ${reservationId}`);
}

async function charge(card: string, amount: number): Promise<string> {
  await sleep(10);
  return `chg_${card.slice(-4)}_${String(amount)}`;
}

// ---------------------------------------------------------------------------
// Reusable step definitions, for the parallel group.
//
// defineStep is a two-stage call: the first fixes the input type (and any
// required prior state), the second infers what the step produces.
// ---------------------------------------------------------------------------

const forOrder = defineStep<OrderInput>();

/** Announces itself so the concurrency limit is visible in the output. */
function lookup<T extends object>(
  name: string,
  delayMs: number,
  produce: () => T,
) {
  return forOrder(name, async () => {
    console.log(`    ${at()}  ${name} ▶`);
    await sleep(delayMs);
    console.log(`    ${at()}  ${name} ■`);
    return produce();
  });
}

const fetchCustomer = lookup('fetch-customer', 60, () => ({
  customerTier: 'premium' as const,
}));
const checkFraud = lookup('check-fraud', 30, () => ({ fraudScore: 0.02 }));
const fetchPricing = lookup('fetch-pricing', 45, () => ({ price: 2500 }));
const fetchShipping = lookup('fetch-shipping', 20, () => ({
  shippingQuote: 499,
}));

// ---------------------------------------------------------------------------
// The pipeline. Read the ctx.<key> reads below: each one is only legal because
// an earlier step declared it.
// ---------------------------------------------------------------------------

const checkout = pipeline<OrderInput>('checkout')
  .step('validate', (ctx) => {
    if (ctx.input.items.length === 0) throw new Error('empty order');
  })
  // Four independent lookups, at most two running at a time.
  .parallel([fetchCustomer, checkFraud, fetchPricing, fetchShipping], {
    concurrency: 2,
  })
  .step('reserve', async (ctx, meta): Promise<Reservation> => {
    // The key is resolved once, before the first attempt, and reused for every
    // retry — which is what lets the warehouse dedupe them.
    console.log(
      `    reserve attempt ${meta.attempt}/${meta.maxAttempts} ` +
        `(key …${meta.idempotencyKey.slice(-16)})`,
    );
    return reserve(ctx.input.items);
  })
  // Sees its own step's output as REQUIRED: a compensation only ever runs for
  // a step that completed. No non-null assertion.
  .undo(async (ctx) => release(ctx.reservationId))
  .retry({ attempts: 3, delayMs: 25, backoff: 'exponential' })
  .step('charge', async (ctx) => ({
    // ctx.price came from the parallel group; ctx.reservationId from the step
    // above. Both are plain `number` and `string` here, not `| undefined`.
    chargeId: await charge(ctx.input.card, ctx.price + ctx.shippingQuote),
  }))
  .undo((ctx) => {
    console.log(`    ↩ refunded ${ctx.chargeId}`);
  })
  .step('discount', () => ({ discountCode: 'SAVE10' }))
  .when((ctx) => ctx.input.items.length > 3)
  .step('ship', (ctx) => {
    if (ctx.input.failOnShip) throw new Error('carrier rejected the shipment');
    return { trackingId: `trk_${ctx.input.orderId}` };
  })
  .step('audit', (ctx) => {
    // Everything produced above is in scope and required — except the guarded
    // step's output, which the types correctly widen to `string | undefined`.
    const line = [
      `tier=${ctx.customerTier}`,
      `fraud=${String(ctx.fraudScore)}`,
      `reservation=${ctx.reservationId}@${ctx.warehouse}`,
      `charge=${ctx.chargeId}`,
      `tracking=${ctx.trackingId}`,
      `discount=${ctx.discountCode ?? '(none — step was guarded out)'}`,
    ].join(' ');
    console.log(`    audit sees: ${line}`);
  });

// ---------------------------------------------------------------------------
// Run 1 — four items, so the guarded discount step runs.
// ---------------------------------------------------------------------------

console.log('▶ run 1: successful order (4 items, discount applies)');
runStartedAt = performance.now();

const ok = await checkout.execute({
  orderId: 'ord_42',
  items: [
    { sku: 'A-1', qty: 1 },
    { sku: 'B-2', qty: 2 },
    { sku: 'C-3', qty: 1 },
    { sku: 'D-4', qty: 3 },
  ],
  card: '4242424242424242',
  failOnShip: false,
});

console.log(`    ok: ${String(ok.ok)} | ${ok.durationMs.toFixed(0)}ms`);
console.log(
  '    steps:',
  ok.steps.map((s) => `${s.name}:${s.status}`).join(', '),
);
// The Result's context is typed by the whole chain, so this is a `string`.
const tracking: string = ok.context.trackingId;
console.log(
  `    tracking (typed as string, not string|undefined): ${tracking}`,
);

// ---------------------------------------------------------------------------
// Run 2 — two items (the discount step is guarded out) and a carrier that
// rejects the shipment, so everything completed so far unwinds.
// ---------------------------------------------------------------------------

console.log('\n▶ run 2: shipping fails, so the order rolls back');
runStartedAt = performance.now();

const failed = await checkout.execute({
  orderId: 'ord_43',
  items: [
    { sku: 'A-1', qty: 1 },
    { sku: 'B-2', qty: 1 },
  ],
  card: '4242424242424242',
  failOnShip: true,
});

console.log(`    ok: ${String(failed.ok)} | error: ${failed.error?.message}`);
console.log(
  '    steps:',
  failed.steps.map((s) => `${s.name}:${s.status}`).join(', '),
);

// ---------------------------------------------------------------------------
// The failed Result as JSON-safe log output. The context is excluded by
// default, because it routinely holds PII, tokens, and card data.
// ---------------------------------------------------------------------------

const serialized = serializeResult(failed, { includeStacks: false });
console.log(
  `\n▶ serializeResult(): 'context' in output = ${String('context' in serialized)}`,
);
console.log(
  JSON.stringify(
    {
      ok: serialized.ok,
      pipelineName: serialized.pipelineName,
      error: serialized.error,
      steps: serialized.steps.map((s) => ({
        name: s.name,
        status: s.status,
        attempts: s.attempts,
      })),
    },
    null,
    2,
  ),
);
