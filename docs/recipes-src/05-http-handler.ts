// Runnable against the local source. Published code imports from 'penstock'.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline, serializeResult } from '../../src/index.js';

interface CheckoutInput {
  orderId: string;
}

const reservations = new Set<string>();

const checkout = pipeline<CheckoutInput>('checkout')
  .step('reserve-stock', async (ctx) => {
    reservations.add(ctx.input.orderId);
    return { reservationId: `rsv_${ctx.input.orderId}` };
  })
  .undo(async (ctx) => {
    reservations.delete(ctx.input.orderId);
    console.log(`  [server] rolled back ${ctx.reservationId}`);
  })
  .step('charge-card', async (_ctx, meta) => {
    // Slow on purpose, and honouring the invocation's own signal.
    await sleep(300, undefined, { signal: meta.signal }).catch(() => {
      throw new Error('charge abandoned');
    });
    return { chargeId: 'chg_1' };
  })
  .step('confirm', () => ({ confirmed: true }));

const server = http.createServer((req, res) => {
  void (async () => {
    // Node aborts nothing for you: build a controller and tie it to the socket.
    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'));
    });

    const orderId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('order') ?? 'ord_0';
    const result = await checkout.execute({ orderId }, { signal: controller.signal });

    console.log(`  [server] ${orderId} -> ok=${result.ok} aborted=${result.aborted}`);

    if (res.writableEnded || req.destroyed) return; // nobody is listening
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(serializeResult(result, { includeStacks: false })));
  })();
});

await new Promise<void>((resolve) => server.listen(0, resolve));
const { port } = server.address() as { port: number };
console.log(`listening on :${port}`);

// ── 1. A request that completes ─────────────────────────────────────────────
console.log('=== 1. request runs to completion ===');
const body = await new Promise<string>((resolve) => {
  http.get(`http://localhost:${port}/?order=ord_1`, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve(`${res.statusCode} ${data.slice(0, 60)}...`));
  });
});
console.log(`  [client] ${body}`);
console.log(`  reservations held: ${reservations.size}`);
console.log();

// ── 2. A client that hangs up mid-charge ────────────────────────────────────
console.log('=== 2. client disconnects mid-charge ===');
const aborting = http.get(`http://localhost:${port}/?order=ord_2`, () => {});
aborting.on('error', () => {}); // ECONNRESET on our own destroy
await sleep(60);
console.log('  [client] hanging up');
aborting.destroy();

await sleep(250);
console.log(`  reservations held: ${reservations.size}`);

server.close();
