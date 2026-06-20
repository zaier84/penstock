// Reliability example. Run it with: npm run example:reliability
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { Pipeline, Step } from 'penstock';
//
// It demonstrates the three 0.2.0 reliability features together:
//   - per-step retry with exponential backoff (fetch-inventory)
//   - per-step timeout              (fetch-inventory, charge-payment)
//   - pipeline cancellation via AbortSignal (the second run)
import { Pipeline, Step } from '../src/index.js';
import type { BaseContext, StepReport } from '../src/index.js';

interface OrderInput {
  orderId: string;
  amount: number;
}

// Mid-run fields are optional: they don't exist until the step that sets them.
interface OrderCtx extends BaseContext<OrderInput> {
  inventoryToken?: string;
  chargeId?: string;
}

// A flaky inventory service: it throws on its first two calls and only
// succeeds on the third, so the retry policy below has to kick in twice.
let inventoryCalls = 0;
function reserveInventory(orderId: string): string {
  inventoryCalls += 1;
  if (inventoryCalls < 3) {
    throw new Error(
      `inventory service unavailable (attempt ${inventoryCalls})`,
    );
  }
  return `inv_${orderId}`;
}

const fetchInventory = new Step<OrderCtx>('fetch-inventory', {
  // Each attempt gets up to 2s; on failure, retry up to 3 times total with an
  // exponential backoff (100ms, then 200ms). `run` is the only thing retried.
  run: (ctx) => {
    ctx.inventoryToken = reserveInventory(ctx.input.orderId);
    console.log(`  reserved inventory → ${ctx.inventoryToken}`);
  },
  timeout: 2000,
  retry: { attempts: 3, delayMs: 100, backoff: 'exponential' },
});

const chargePayment = new Step<OrderCtx>('charge-payment', {
  run: (ctx) => {
    ctx.chargeId = `chg_${ctx.input.orderId}`;
    console.log(`  charged ${ctx.input.amount} → ${ctx.chargeId}`);
  },
  // Compensation: if a later step fails (or the pipeline is cancelled after
  // this step completed), the charge is refunded during rollback.
  undo: (ctx) => {
    console.log(`  ↩ refunded charge ${ctx.chargeId}`);
  },
  timeout: 5000,
});

const sendConfirmation = new Step<OrderCtx>('send-confirmation', {
  // A plain step with no reliability options — it still works unchanged.
  run: (ctx) => {
    console.log(`  sent confirmation for order ${ctx.input.orderId}`);
  },
});

const orderPipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(fetchInventory)
  .addStep(chargePayment)
  .addStep(sendConfirmation);

const order: OrderInput = { orderId: 'ord_42', amount: 2500 };

// Renders each step report, surfacing the new `attempts` / `timedOut` fields
// (and `skipReason`) when they are present.
const formatSteps = (steps: StepReport[]): string =>
  steps
    .map((s) => {
      const extra: string[] = [];
      if (s.attempts !== undefined) extra.push(`attempts=${s.attempts}`);
      if (s.timedOut !== undefined) extra.push(`timedOut=${s.timedOut}`);
      if (s.skipReason !== undefined) extra.push(s.skipReason);
      return `${s.name}:${s.status}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    })
    .join('\n    ');

console.log(
  '▶ successful order (fetch-inventory fails twice, then retries succeed)',
);
const ok = await orderPipeline.execute(order);
console.log('  ok:', ok.ok, '| chargeId:', ok.context.chargeId);
console.log('  steps:\n   ', formatSteps(ok.steps));

// Cancellation: a caller passes an AbortSignal to execute(). penstock checks it
// between steps, so a pre-aborted signal stops the run before the first step.
// Nothing has completed yet, so the rollback chain runs but has nothing to undo
// (rollbackErrors is empty) — the same path a mid-run cancel takes to roll back.
console.log('\n▶ cancelled order (signal aborted before execute)');
const controller = new AbortController();
controller.abort(new Error('order cancelled by customer'));
const cancelled = await orderPipeline.execute(order, {
  signal: controller.signal,
});
console.log('  ok:', cancelled.ok, '| error:', cancelled.error?.message);
console.log('  rollbackErrors:', cancelled.rollbackErrors);
console.log('  steps:\n   ', formatSteps(cancelled.steps));
