// Runnable against the local source. Published code imports from 'penstock'.
import { pipeline, serializeResult } from '../../src/index.js';
import type { Logger } from '../../src/index.js';

interface PaymentInput {
  orderId: string;
  card: { number: string; cvv: string }; // the kind of thing a context holds
}

// ── A stand-in for your aggregator: one JSON object per line ────────────────
const shipped: string[] = [];
const aggregator = {
  send(level: string, message: string, fields: Record<string, unknown>) {
    shipped.push(JSON.stringify({ level, message, ...fields }));
  },
};

// A Logger is four methods. Adapting any structured logger takes this long.
const appLogger: Logger = {
  debug: (msg, meta) => aggregator.send('debug', msg, meta ?? {}),
  info: (msg, meta) => aggregator.send('info', msg, meta ?? {}),
  warn: (msg, meta) => aggregator.send('warn', msg, meta ?? {}),
  error: (msg, meta) => aggregator.send('error', msg, meta ?? {}),
};

const checkout = pipeline<PaymentInput>('checkout')
  .step('tokenize', (ctx) => ({ token: `tok_${ctx.input.card.number.slice(-4)}` }))
  .step('charge', (ctx) => {
    throw new Error(`gateway declined ${ctx.token}`);
  })
  .retry({ attempts: 2, delayMs: 5 })
  // One structured record per run, whatever the outcome.
  .onSettled((result) => {
    const record = serializeResult(result, { includeStacks: !result.ok });
    if (result.ok) appLogger.info('checkout settled', { ...record });
    else if (result.aborted) appLogger.warn('checkout cancelled', { ...record });
    else appLogger.error('checkout failed', { ...record });
  });

const result = await checkout.execute(
  { orderId: 'ord_9', card: { number: '4242424242424242', cvv: '123' } },
  { logger: appLogger },
);

// ── What the library itself logged during the run ───────────────────────────
console.log('=== lines the library emitted ===');
for (const line of shipped.slice(0, -1)) console.log(`  ${line}`);
console.log();

console.log('=== does anything carry the card number? ===');
const everything = shipped.join('\n');
console.log(`  "4242424242424242" appears: ${everything.includes('4242424242424242')}`);
console.log(`  cvv "123" appears:          ${/"cvv"/.test(everything)}`);
console.log(`  context present at all:     ${/"context"/.test(everything)}`);
console.log();

// ── The one record from onSettled ───────────────────────────────────────────
const safe = serializeResult(result, { includeStacks: false });
console.log('=== the settled record (stacks stripped for readability) ===');
console.log(JSON.stringify(safe, null, 2).split('\n').slice(0, 26).join('\n'));
console.log('  ...');
console.log();

console.log('=== opting in is explicit, and takes everything with it ===');
const withContext = serializeResult(result, { includeContext: true, includeStacks: false });
const ctxKeys = Object.keys(withContext.context as object);
console.log(`  context keys: ${ctxKeys.join(', ')}`);
console.log(`  card number now present: ${JSON.stringify(withContext).includes('4242424242424242')}`);
