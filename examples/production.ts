// Production example. Run it with: npm run example:production
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { Pipeline, Step, serializeResult } from 'penstock';
//
// It puts the four 0.4.0 "production integration" features into one order flow:
//   - a business-derived idempotency key that stays stable across retries
//     (charge-payment prints it on every attempt, so you can see it not move)
//   - a parallel group bounded to `concurrency: 2` over four steps, which print
//     their own start and end times so the pooling is visible
//   - tracing through the core `Tracer` interface, implemented below as a
//     console tracer — so this example needs no OpenTelemetry install. The
//     `penstock/otel` adapter implements that same interface, so swapping in
//     `otelTracer()` from 'penstock/otel' is the only change needed for real
//     distributed tracing.
//   - `serializeResult()` turning a failed run into JSON-safe log output, with
//     the context excluded by default
import { Pipeline, Step, serializeResult } from '../src/index.js';
import type { BaseContext, TraceSpan, Tracer } from '../src/index.js';

// ---------------------------------------------------------------------------
// A console tracer: the whole core Tracer interface is four span methods.
// ---------------------------------------------------------------------------

interface SpanNode {
  name: string;
  children: SpanNode[];
  idempotencyKey?: string;
  status?: string;
  durationMs: number;
}

/**
 * Collects spans into a tree and prints it. Parenting works exactly the way
 * the OpenTelemetry adapter's does: a private map from the `TraceSpan` handed
 * back to penstock to this tracer's own record of it.
 */
function consoleTracer(): { tracer: Tracer; printTree: () => void } {
  const roots: SpanNode[] = [];
  const nodes = new WeakMap<TraceSpan, SpanNode>();

  const tracer: Tracer = {
    startSpan(name, parent) {
      const startedAt = performance.now();
      const node: SpanNode = { name, children: [], durationMs: 0 };
      const parentNode = parent === undefined ? undefined : nodes.get(parent);
      if (parentNode === undefined) roots.push(node);
      else parentNode.children.push(node);

      const span: TraceSpan = {
        setAttribute: (key, value) => {
          // Only names, ids, statuses, counts, durations and the idempotency
          // key ever arrive here — never a context or input value.
          if (key === 'penstock.step.idempotency_key') {
            node.idempotencyKey = String(value);
          }
        },
        recordException: () => {},
        setStatus: (status, message) => {
          node.status =
            message === undefined ? status : `${status}: ${message}`;
        },
        end: () => {
          node.durationMs = performance.now() - startedAt;
        },
      };
      nodes.set(span, node);
      return span;
    },
  };

  const render = (node: SpanNode, depth: number): void => {
    const key =
      node.idempotencyKey === undefined ? '' : `  key=${node.idempotencyKey}`;
    console.log(
      `  ${'  '.repeat(depth)}${node.name} ` +
        `(${node.durationMs.toFixed(0)}ms) [${node.status ?? '-'}]${key}`,
    );
    for (const child of node.children) render(child, depth + 1);
  };

  return {
    tracer,
    printTree: () => {
      for (const root of roots) render(root, 0);
    },
  };
}

// ---------------------------------------------------------------------------
// The order flow.
// ---------------------------------------------------------------------------

interface OrderInput {
  orderId: string;
  amount: number;
  failOnShip: boolean;
}

// Every parallel step writes to its own key: steps in a group share one
// mutable context, so two of them writing the same field would race.
interface OrderCtx extends BaseContext<OrderInput> {
  inventoryToken?: string;
  fraudScore?: number;
  price?: number;
  shippingQuote?: number;
  chargeId?: string;
  trackingId?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let runStartedAt = performance.now();
const at = (): string =>
  `t+${String(Math.round(performance.now() - runStartedAt)).padStart(3, ' ')}ms`;

/** One of the four lookups in the bounded group; announces when it runs. */
function lookup(
  name: string,
  delayMs: number,
  apply: (ctx: OrderCtx) => void,
): Step<OrderCtx> {
  return new Step<OrderCtx>(name, async (ctx) => {
    console.log(`  ${at()}  ${name} ▶ start`);
    await sleep(delayMs);
    apply(ctx);
    console.log(`  ${at()}  ${name} ■ end`);
  });
}

const validateOrder = new Step<OrderCtx>('validate-order', (ctx) => {
  if (ctx.input.amount <= 0) throw new Error('order amount must be positive');
});

const fetchInventory = new Step<OrderCtx>('fetch-inventory', {
  run: async (ctx) => {
    console.log(`  ${at()}  fetch-inventory ▶ start`);
    await sleep(120);
    ctx.inventoryToken = `inv_${ctx.input.orderId}`;
    console.log(`  ${at()}  fetch-inventory ■ end`);
  },
  // The one step in the group that reserves something, so rollback has work.
  undo: (ctx) => {
    console.log(`  ↩ released inventory ${ctx.inventoryToken}`);
  },
});

const checkFraud = lookup('check-fraud', 60, (ctx) => {
  ctx.fraudScore = 0.02;
});
const fetchPricing = lookup('fetch-pricing', 90, (ctx) => {
  ctx.price = ctx.input.amount;
});
const fetchShippingRates = lookup('fetch-shipping-rates', 40, (ctx) => {
  ctx.shippingQuote = 499;
});

// The payment gateway is flaky: it rejects the first two calls of the process.
let gatewayCalls = 0;

const chargePayment = new Step<OrderCtx>('charge-payment', {
  run: (ctx, meta) => {
    gatewayCalls += 1;
    console.log(
      `  attempt ${meta.attempt}/${meta.maxAttempts}  ` +
        `idempotencyKey=${meta.idempotencyKey}`,
    );
    if (gatewayCalls < 3) throw new Error('payment gateway timeout');
    ctx.chargeId = `chg_${ctx.input.orderId}`;
    console.log(`  charged ${ctx.input.amount} → ${ctx.chargeId}`);
  },
  undo: (ctx, meta) => {
    console.log(
      `  ↩ refunded ${ctx.chargeId} (undo key ${meta.idempotencyKey})`,
    );
  },
  retry: { attempts: 3, delayMs: 25 },
  // Derived from the order, not from the execution: every attempt — and every
  // *re-run* of this order — presents the gateway with the same key, which is
  // what lets it dedupe. The default key would be `${executionId}:${stepName}`,
  // unique per execution and so useless for cross-run deduplication.
  idempotencyKey: (ctx) => `charge:${ctx.input.orderId}:${ctx.input.amount}`,
});

const shipOrder = new Step<OrderCtx>('ship-order', (ctx) => {
  if (ctx.input.failOnShip) throw new Error('carrier rejected the shipment');
  ctx.trackingId = `trk_${ctx.input.orderId}`;
});

const orderPipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validateOrder)
  // Four independent lookups, at most two of them in flight at a time.
  .addParallel([fetchInventory, checkFraud, fetchPricing, fetchShippingRates], {
    concurrency: 2,
  })
  .addStep(chargePayment)
  .addStep(shipOrder);

// ---------------------------------------------------------------------------
// Run 1 — success. Watch the pool, the retries, and the stable key.
// ---------------------------------------------------------------------------

console.log('▶ run 1: successful order');
const first = consoleTracer();
runStartedAt = performance.now();
const ok = await orderPipeline.execute(
  { orderId: 'ord_42', amount: 2500, failOnShip: false },
  { tracer: first.tracer },
);
console.log(`  ok: ${ok.ok} | tracking: ${ok.context.trackingId}`);
console.log(`  executionId: ${ok.executionId} | ${ok.durationMs.toFixed(0)}ms`);

// Only two of the four lookups ever overlap, and charge-payment holds one key
// across all three attempts.
console.log('\n  span tree:');
first.printTree();

// ---------------------------------------------------------------------------
// Run 2 — the carrier rejects the shipment, so everything unwinds.
// ---------------------------------------------------------------------------

console.log('\n▶ run 2: shipping fails, so the order rolls back');
const second = consoleTracer();
runStartedAt = performance.now();
const failed = await orderPipeline.execute(
  { orderId: 'ord_42', amount: 2500, failOnShip: true },
  { tracer: second.tracer },
);
console.log(`  ok: ${failed.ok} | error: ${failed.error?.message}`);

console.log('\n  span tree (note the penstock.undo spans):');
second.printTree();

// ---------------------------------------------------------------------------
// The failed Result as JSON-safe log output.
// ---------------------------------------------------------------------------

// `context` is excluded unless you ask for it: a serialized Result is destined
// for a log aggregator, and contexts routinely hold PII, tokens and card data.
// Stacks are dropped here purely to keep the example's output readable.
const serialized = serializeResult(failed, { includeStacks: false });
console.log(
  `\n▶ serializeResult(): 'context' in output = ${'context' in serialized}` +
    ' (excluded by default)',
);
console.log(JSON.stringify(serialized, null, 2));
