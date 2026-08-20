---
title: Payment with idempotent retry
description: The double-charge failure mode, demonstrated — a retried charge billing the customer twice, and the one line that prevents it.
sidebar:
  order: 2
---

## The problem

A payment gateway takes your call, moves the money, and then the response is
lost on the way back — a socket reset, a load balancer timeout, a deploy at the
wrong moment. Your code sees a failure. **The customer has been charged.**

Now add a retry. The retry charges them again.

This is the single most expensive bug in this class of code, and it is exactly
what idempotency keys exist to prevent. The gateway below behaves like a real
one: it deduplicates on the key you send, and it fails by recording the charge
and *then* losing the response.

```ts
class Gateway {
  async charge(orderId, amount, { idempotencyKey } = {}) {
    if (idempotencyKey !== undefined && this.seen.has(idempotencyKey)) {
      // Already processed. Return the original charge; do not charge again.
      return this.seen.get(idempotencyKey);
    }

    const id = `chg_${this.charges.length + 1}`;
    this.charges.push({ id, orderId, amount });
    if (idempotencyKey !== undefined) this.seen.set(idempotencyKey, id);

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      // The money moved. The caller will never learn that.
      throw new Error('gateway timeout (response lost)');
    }
    return id;
  }
}
```

## 1. A retry with no key charges twice

```ts
const p = pipeline<PaymentInput>('checkout')
  .step('charge', async (ctx) => ({
    // No idempotency key at all — the gateway cannot tell attempt 2 from a
    // brand new payment.
    chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount),
  }))
  .retry({ attempts: 3, delayMs: 10 });
```

```text
=== 1. retry, no idempotency key ===
ok: true | attempts: 2
  RESULT: 2 charge(s) on the account
    chg_1 ord_7 25.00
    chg_2 ord_7 25.00
```

Read that carefully, because it is the whole point of this page. **The run
succeeded.** `ok: true`. Every log line is green, the order ships, nobody is
paged — and the customer paid £50 for a £25 order. The only trace of the problem
is `attempts: 2`.

## 2. Forwarding the key the step already has

Every step has an idempotency key whether or not you configure one. Pass it on:

```ts
const p = pipeline<PaymentInput>('checkout')
  .step('charge', async (ctx, meta) => ({
    chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey,
    }),
  }))
  .retry({ attempts: 3, delayMs: 10 });
```

```text
=== 2. retry, meta.idempotencyKey forwarded ===
ok: true | attempts: 2
  RESULT: 1 charge(s) on the account
    chg_1 ord_7 25.00
```

Same failure, same two attempts, **one charge**. The key is resolved once,
before the first attempt, and reused unchanged for every retry — so attempt 2
arrives carrying the key attempt 1 already registered, and the gateway hands
back the original charge instead of making a new one.

That is one added argument. It is the difference between the two outputs above.

## 3. The default key does not survive a re-run

The default is `` `${executionId}:${stepName}` ``, and `executionId` is a fresh
UUID per `execute()` call. That makes it safe for retries **inside** one run and
deliberately useless across runs:

```text
=== 3. two runs for the same order, default key ===
  run 1 key: e51384d8...:charge
  run 2 key: e2dc99f6...:charge
  RESULT: 2 charge(s) on the account
    chg_1 ord_7 25.00
    chg_2 ord_7 25.00
```

Two different keys, two charges. This is the failure mode that bites when an
operator replays a failed job, or a queue redelivers a message, or someone
double-clicks.

## 4. Derive the key from the business fact

```ts
const p = pipeline<PaymentInput>('checkout')
  .step('charge', async (ctx, meta) => ({
    chargeId: await gateway.charge(ctx.input.orderId, ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey,
    }),
  }))
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}:${ctx.input.amount}`);
```

```text
=== 4. two runs for the same order, business-derived key ===
  run 1 key: charge:ord_7:2500
  run 2 key: charge:ord_7:2500
  same chargeId returned: true
  RESULT: 1 charge(s) on the account
    chg_1 ord_7 25.00
```

The key now describes **which payment this is**, not which attempt or which
process. Replay the job as many times as you like: one charge.

*(The UUIDs in scenario 3 differ on every run, by design. Everything else here
is reproducible.)*

## Choosing the key

A good key answers "which business action is this?" — an order id, a transfer
id, an invoice number, plus enough to keep two different actions on the same
entity apart. `charge:ord_7:2500` is fine; `charge:ord_7` is fine if an order is
only ever charged once.

A bad key changes when it should not (`Date.now()`, a random value, the attempt
number) or stays the same when it should not (a bare customer id, which would
deduplicate two genuinely different orders).

**Do not derive it from the card number or anything else sensitive.** The key
you supply is recorded on `StepReport.idempotencyKey` and emitted as the
`penstock.step.idempotency_key` [trace attribute](../../guides/tracing/) — so a
key built from a PAN puts that PAN in your tracing backend and your logs.

## It is auditable

```ts
expect(result.steps[0]?.idempotencyKey).toBe('charge:ord_7:2500');
```

Retry-safety is something a test asserts rather than something you hope was
wired up. See [Testing your pipelines](../../guides/testing/).

## Compensations get their own key

An `undo` runs under the run key plus `:undo`, so a refund and the charge it
reverses are never mistaken for the same operation by a gateway deduplicating on
the key.

## Next

- [Idempotency](../../guides/idempotency/) — the full guide.
- [Retry and backoff](../../guides/retry/) — what makes the key necessary.
- [Order processing saga](../order-saga/) — this step in a complete flow.
