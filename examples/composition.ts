// Composition example. Run it with: npm run example:composition
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { Pipeline, Step } from 'penstock';
//
// It demonstrates the three 0.3.0 composition features together:
//   - parallel step groups         (addParallel: pricing + fraud + inventory)
//   - pipeline-as-step composition (the fraud check is its own nested pipeline)
//   - lifecycle events             (onComplete / onFailure / onCancel / onSettled)
import { Pipeline, Step } from '../src/index.js';
import type { BaseContext, Result, StepReport } from '../src/index.js';

interface OrderInput {
  orderId: string;
  amounts: number[];
  declineCard?: boolean;
}

// Mid-run fields are optional: they don't exist until the step that sets them.
// Each parallel step writes its OWN key — parallel steps share one mutable
// context, so distinct keys are what keep the group race-free.
interface OrderCtx extends BaseContext<OrderInput> {
  total?: number;
  price?: number;
  fraudScore?: number;
  inventoryToken?: string;
  chargeId?: string;
}

interface FraudInput {
  orderId: string;
  total: number;
}

interface FraudCtx extends BaseContext<FraudInput> {
  score?: number;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The nested pipeline: an independent unit with its own context and steps.
// It knows nothing about orders — it receives only what mapInput derives.
const fraudPipeline = new Pipeline<FraudCtx>('fraud-check')
  .addStep(
    new Step<FraudCtx>('screen-order', async () => {
      await wait(20);
    }),
  )
  .addStep(
    new Step<FraudCtx>('score-risk', async (ctx) => {
      await wait(20);
      ctx.score = ctx.input.total > 10_000 ? 0.8 : 0.1;
    }),
  );

const validateOrder = new Step<OrderCtx>('validate-order', (ctx) => {
  if (ctx.input.amounts.length === 0) throw new Error('order is empty');
  ctx.total = ctx.input.amounts.reduce((sum, n) => sum + n, 0);
});

const fetchPricing = new Step<OrderCtx>('fetch-pricing', {
  run: async (ctx) => {
    await wait(30);
    ctx.price = ctx.total;
    console.log(`  priced order at ${ctx.price}`);
  },
});

// The whole fraud pipeline wrapped as ONE step of the checkout pipeline.
const checkFraud = fraudPipeline.asStep<OrderCtx>('check-fraud', {
  mapInput: (ctx) => ({ orderId: ctx.input.orderId, total: ctx.total ?? 0 }),
  mapResult: (innerResult, ctx) => {
    ctx.fraudScore = (innerResult as Result<FraudCtx>).context.score;
    console.log(`  fraud score ${ctx.fraudScore}`);
  },
  // A committed inner pipeline is never re-rolled-back by penstock — this
  // undo is where YOU reverse its net effect during outer rollback.
  undo: (ctx) => {
    console.log(`  ↩ discarded fraud assessment for ${ctx.input.orderId}`);
  },
});

const fetchInventory = new Step<OrderCtx>('fetch-inventory', {
  run: async (ctx) => {
    await wait(50);
    ctx.inventoryToken = `inv_${ctx.input.orderId}`;
    console.log(`  reserved inventory → ${ctx.inventoryToken}`);
  },
  undo: (ctx) => {
    console.log(`  ↩ released inventory ${ctx.inventoryToken}`);
  },
});

const chargePayment = new Step<OrderCtx>('charge-payment', {
  run: (ctx) => {
    if (ctx.input.declineCard) throw new Error('card declined');
    ctx.chargeId = `chg_${ctx.input.orderId}`;
    console.log(`  charged ${ctx.price} → ${ctx.chargeId}`);
  },
  undo: (ctx) => {
    console.log(`  ↩ refunded charge ${ctx.chargeId}`);
  },
});

const checkout = new Pipeline<OrderCtx>('checkout')
  .addStep(validateOrder)
  // One logical position; all three run concurrently (~50ms, not ~100ms).
  .addParallel([fetchPricing, checkFraud, fetchInventory])
  .addStep(chargePayment)
  // Lifecycle events observe the settled run — they fire after any rollback.
  .onComplete((result) => {
    console.log(
      `  ✔ onComplete: order confirmed (${result.steps.length} steps)`,
    );
  })
  .onFailure((result) => {
    console.log(`  ✖ onFailure: ${result.error?.message}`);
  })
  .onCancel((result) => {
    console.log(`  ⊘ onCancel: ${result.error?.message}`);
  })
  .onSettled((result) => {
    console.log(`  ◼ onSettled: ok=${result.ok} aborted=${result.aborted}`);
  });

// Renders each step report with its wall-clock duration — the three parallel
// steps each show their own ~30-50ms, yet the group as a whole took ~50ms.
const formatSteps = (steps: StepReport[]): string =>
  steps
    .map((s) => `${s.name}:${s.status} (${s.durationMs.toFixed(0)}ms)`)
    .join('\n    ');

console.log('▶ successful checkout (pricing, fraud, inventory in parallel)');
const started = performance.now();
const ok = await checkout.execute({ orderId: 'ord_42', amounts: [1200, 800] });
const elapsed = performance.now() - started;
console.log('  ok:', ok.ok, `| pipeline took ${elapsed.toFixed(0)}ms`);
console.log('  steps:\n   ', formatSteps(ok.steps));

// The wrapping step's report carries the nested pipeline's full Result, so
// the inner execution stays inspectable without mapResult.
const fraudReport = ok.steps.find((s) => s.name === 'check-fraud');
const innerResult = fraudReport?.innerResult as Result<FraudCtx>;
console.log(
  '  check-fraud innerResult: ok:',
  innerResult.ok,
  '| steps:\n   ',
  formatSteps(innerResult.steps),
);

// Forced failure AFTER the parallel group: charge-payment throws, and the
// rollback walks backwards through the group — reverse declaration order —
// running each undo (release inventory, discard the fraud assessment).
console.log('\n▶ declined card (rollback across the parallel group)');
const failed = await checkout.execute({
  orderId: 'ord_43',
  amounts: [500],
  declineCard: true,
});
console.log('  ok:', failed.ok, '| error:', failed.error?.message);
console.log('  rollbackErrors:', failed.rollbackErrors);
console.log('  steps:\n   ', formatSteps(failed.steps));
