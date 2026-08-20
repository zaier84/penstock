---
title: A pipeline inside an HTTP handler
description: Wiring the request's lifetime into execute, so a client that hangs up rolls back the work already done for it.
sidebar:
  order: 5
---

## The problem

A checkout endpoint reserves stock, then charges a card. The client hangs up
halfway — a closed tab, a mobile network dropping, a gateway timeout upstream.

Without a cancellation signal the pipeline runs to completion for nobody,
charges a card whose response nothing will read, and leaves a reservation that
no order will ever claim.

## The code

Node does not abort anything for you. Build an `AbortController`, tie it to the
socket closing, and hand its signal to `execute`:

```ts
import http from 'node:http';
import { pipeline, serializeResult } from 'penstock';

const server = http.createServer((req, res) => {
  void (async () => {
    // Node aborts nothing for you: build a controller and tie it to the socket.
    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'));
    });

    const orderId = new URL(req.url ?? '/', 'http://localhost')
      .searchParams.get('order') ?? 'ord_0';

    const result = await checkout.execute({ orderId }, { signal: controller.signal });

    if (res.writableEnded || req.destroyed) return; // nobody is listening
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(serializeResult(result, { includeStacks: false })));
  })();
});
```

The `res.writableEnded` check inside the `close` handler matters: `close` fires
on **every** request, including successful ones, once the response is done.
Without the guard you would abort a pipeline that had already finished.

The pipeline itself is ordinary, except that the slow step forwards
`meta.signal` — which is what actually stops the work:

```ts
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
    await sleep(300, undefined, { signal: meta.signal }).catch(() => {
      throw new Error('charge abandoned');
    });
    return { chargeId: 'chg_1' };
  })
  .step('confirm', () => ({ confirmed: true }));
```

## The output

Two real requests against a real server: one that completes, one where the
client hangs up 60ms in, mid-charge.

```text
listening on :57245
=== 1. request runs to completion ===
  [server] ord_1 -> ok=true aborted=false
  [client] 200 {"ok":true,"aborted":false,"executionId":"bd9e6fbd-b8dd-42cb...
  reservations held: 1

=== 2. client disconnects mid-charge ===
  [client] hanging up
  [server] rolled back rsv_ord_2
  [server] ord_2 -> ok=false aborted=true
  reservations held: 1
```

*(The port and execution id differ on every run.)*

## Reading it

**The disconnect rolled the reservation back.** `reservations held` stays at
`1` across both requests — that one belongs to `ord_1`, the order that actually
completed. `ord_2` left nothing behind.

**`aborted: true`, not just `ok: false`.** That flag is how you tell "the client
left" from "the payment was declined". One is routine, the other deserves an
alert. It is also what routes the run to `onCancel` rather than `onFailure` in
[lifecycle events](../../guides/lifecycle-events/).

**The response is skipped when nobody is listening.** Writing to a destroyed
socket throws; the `writableEnded || destroyed` guard is why the second request
logs a result without attempting a write.

## Express and Fastify

**Not executed** — the runnable file uses `node:http` so it depends on nothing.
The adaptation is mechanical; only the way you reach the raw request differs:

```ts
// Express 5
app.post('/checkout', async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  });

  const result = await checkout.execute(req.body, { signal: controller.signal });
  if (res.writableEnded) return;
  res.status(result.ok ? 200 : 500).json(serializeResult(result));
});

// Fastify
fastify.post('/checkout', async (request, reply) => {
  const controller = new AbortController();
  request.raw.on('close', () => {
    if (!reply.sent) controller.abort(new Error('client disconnected'));
  });

  const result = await checkout.execute(request.body, { signal: controller.signal });
  return reply.code(result.ok ? 200 : 500).send(serializeResult(result));
});
```

## Adding a server-side deadline

A client that never hangs up is not the same as a request that should run
forever. Combine the socket signal with a deadline using `AbortSignal.any`,
which is a Node built-in:

```ts
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
const result = await checkout.execute({ orderId }, { signal });
```

Either the client leaving or the deadline elapsing now stops the run and rolls
it back. See [Background job with a timeout budget](../background-job/).

## Do not send the whole Result

`serializeResult` excludes `result.context` by default, which is the right
behaviour for a response body as much as for a log line — the context holds
whatever your steps put there. Send the fields the client needs, or the
serialized result as-is; do not reach for `includeContext: true` on a public
endpoint.

## Next

- [Cancellation](../../guides/cancellation/) — `ctx.signal` versus `meta.signal`.
- [Serialization and logging](../../guides/serialization/) — what crosses the wire.
- [Background job](../background-job/) — the same signal wiring, on a schedule.
