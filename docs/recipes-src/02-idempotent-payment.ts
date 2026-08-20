// Runnable against the local source. Published code imports from 'penstock'.
import { pipeline } from '../../src/index.js';

interface PaymentInput {
  orderId: string;
  amount: number;
  card: string;
}

// ── A payment gateway that behaves like a real one ──────────────────────────
// It deduplicates on the idempotency key, and it fails the way real gateways
// fail: the charge is recorded, then the response is lost on the way back.
class Gateway {
  readonly charges: { id: string; orderId: string; amount: number }[] = [];
  private readonly seen = new Map<string, string>();
  private dropNextResponse = false;

  dropTheNextResponse() {
    this.dropNextResponse = true;
  }

  async charge(
    orderId: string,
    amount: number,
    options: { idempotencyKey?: string } = {},
  ): Promise<string> {
    const key = options.idempotencyKey;

    if (key !== undefined && this.seen.has(key)) {
      // Already processed. Return the original charge; do not charge again.
      return this.seen.get(key)!;
    }

    const id = `chg_${this.charges.length + 1}`;
    this.charges.push({ id, orderId, amount });
    if (key !== undefined) this.seen.set(key, id);

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      // The money moved. The caller will never learn that.
      throw new Error('gateway timeout (response lost)');
    }
    return id;
  }
}

const report = (label: string, gateway: Gateway) => {
  console.log(`${label}: ${gateway.charges.length} charge(s) on the account`);
  for (const c of gateway.charges) {
    console.log(`    ${c.id} ${c.orderId} ${(c.amount / 100).toFixed(2)}`);
  }
};

const input: PaymentInput = { orderId: 'ord_7', amount: 2500, card: 'tok_visa' };

// ── 1. A retry with NO stable key charges twice ─────────────────────────────
{
  const gateway = new Gateway();
  const p = pipeline<PaymentInput>('checkout')
    .step('charge', async (ctx) => ({
      // No idempotency key at all — the gateway cannot tell attempt 2 from a
      // brand new payment.
      chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount),
    }))
    .retry({ attempts: 3, delayMs: 10 });

  gateway.dropTheNextResponse();
  const result = await p.execute(input);
  console.log('=== 1. retry, no idempotency key ===');
  console.log(`ok: ${result.ok} | attempts: ${result.steps[0]?.attempts}`);
  report('  RESULT', gateway);
  console.log();
}

// ── 2. The same retry WITH the key the step was given ───────────────────────
{
  const gateway = new Gateway();
  const p = pipeline<PaymentInput>('checkout')
    .step('charge', async (ctx, meta) => ({
      chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount, {
        idempotencyKey: meta.idempotencyKey,
      }),
    }))
    .retry({ attempts: 3, delayMs: 10 });

  gateway.dropTheNextResponse();
  const result = await p.execute(input);
  console.log('=== 2. retry, meta.idempotencyKey forwarded ===');
  console.log(`ok: ${result.ok} | attempts: ${result.steps[0]?.attempts}`);
  report('  RESULT', gateway);
  console.log();
}

// ── 3. Re-running the pipeline: the DEFAULT key is not stable across runs ───
{
  const gateway = new Gateway();
  const p = pipeline<PaymentInput>('checkout').step('charge', async (ctx, meta) => ({
    chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey,
    }),
  }));

  const first = await p.execute(input);
  const second = await p.execute(input); // same order, retried by an operator
  console.log('=== 3. two runs for the same order, default key ===');
  console.log(`  run 1 key: ${first.steps[0]?.idempotencyKey?.slice(0, 8)}...:charge`);
  console.log(`  run 2 key: ${second.steps[0]?.idempotencyKey?.slice(0, 8)}...:charge`);
  report('  RESULT', gateway);
  console.log();
}

// ── 4. Re-running the pipeline with a BUSINESS-derived key ──────────────────
{
  const gateway = new Gateway();
  const p = pipeline<PaymentInput>('checkout')
    .step('charge', async (ctx, meta) => ({
      chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount, {
        idempotencyKey: meta.idempotencyKey,
      }),
    }))
    .idempotencyKey((ctx) => `charge:${ctx.input.orderId}:${ctx.input.amount}`);

  const first = await p.execute(input);
  const second = await p.execute(input);
  console.log('=== 4. two runs for the same order, business-derived key ===');
  console.log(`  run 1 key: ${first.steps[0]?.idempotencyKey}`);
  console.log(`  run 2 key: ${second.steps[0]?.idempotencyKey}`);
  console.log(`  same chargeId returned: ${first.context.chargeId === second.context.chargeId}`);
  report('  RESULT', gateway);
}
