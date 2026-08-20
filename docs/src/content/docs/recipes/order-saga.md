---
title: Order processing saga
description: The canonical end-to-end example — four services, reverse-order compensation, and proof that a failed order leaves nothing behind.
sidebar:
  order: 1
---

## The problem

A checkout touches four systems: inventory, payments, shipping, and
notifications. Each one commits independently. If the carrier rejects the
shipment *after* the card is charged, you owe the customer a refund and the
warehouse a release — and if you get that wrong, the failure is silent and
expensive.

This is the canonical saga: no distributed transaction is available, so every
step carries its own reversal.

## The code

```ts
import { pipeline } from 'penstock';

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
    chargeId: await payments.charge(ctx.input.card, ctx.total, ctx.input.orderId),
  }))
  .undo(async (ctx) => payments.refund(ctx.chargeId))
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}`)
  .step('book-shipment', async (ctx) => ({
    shipmentId: await shipping.book(ctx.input.orderId),
  }))
  .undo(async (ctx) => shipping.cancel(ctx.shipmentId))
  .step('notify-customer', async (ctx) => {
    await notifications.send(ctx.input.customerId, ctx.shipmentId);
  })
  .onSettled((r) => console.log(`  [audit] ${r.pipelineName} ok=${r.ok}`));
```

Four things are worth noticing before the output.

**`validate-order` returns `total`**, and `charge-card` reads `ctx.total` as a
`number` — required, not `number | undefined`. Nothing declared a context
interface.

**Each `.undo()` sits under the step it reverses**, and reads that step's own
output. `ctx.reservationId` inside the release needs no `!`.

**`notify-customer` has no `undo`.** You cannot unsend an email, and declaring
no compensation says exactly that. It stays `completed` through a rollback.

**The charge carries a business-derived idempotency key**, so re-running this
order presents the gateway with the same key rather than charging twice. See
[recipe 2](../idempotent-payment/).

## The output

The runnable source adds a `failAt` switch to the input so the two failure
scenarios can be forced; everything else is exactly the code above. Three runs
against the same pipeline: the happy path, a shipping failure after
the card was charged, and a declined card. The counters at the end of each are
the live state of the three stores.

```text
=== happy path ===
  [notify] told cust_42 about shp_ord_1001
  [audit] checkout ok=true
ok: true
  validate-order  completed
  reserve-stock   completed
  charge-card     completed
  book-shipment   completed
  notify-customer completed
left behind -> reserved:1 charges:1 shipments:1

=== shipping fails after the card was charged ===
  [payments] refunded chg_ord_1002_3000
  [inventory] released rsv_ord_1002
  [audit] checkout ok=false
ok: false | error: Step "book-shipment" failed
  validate-order  completed
  reserve-stock   rolled-back
  charge-card     rolled-back
  book-shipment   failed
left behind -> reserved:0 charges:0 shipments:0

=== the card is declined ===
  [inventory] released rsv_ord_1003
  [audit] checkout ok=false
ok: false | error: Step "charge-card" failed
  validate-order  completed
  reserve-stock   rolled-back
  charge-card     failed
left behind -> reserved:0 charges:0 shipments:0
```

## Reading it

**The happy path leaves `1/1/1`** — one reservation, one charge, one shipment.
That is the committed order, and it is the only run that should leave anything.

**Both failures leave `0/0/0`.** Nothing is orphaned. In the shipping failure
the refund ran *before* the release, mirroring the order they were created in —
refunding a charge against a reservation you already released is the wrong order
in most domains, and you did not have to think about it.

**The declined card released the reservation and stopped.** `charge-card` is
`failed`, not `rolled-back`: the failing step is never compensated, because its
work did not finish. `validate-order` stayed `completed` — it has no `undo`, so
there was nothing to reverse.

**`book-shipment` never appears in the third run.** Steps after the failure are
not reached and get no report at all. That is different from a
[cancelled](../../guides/cancellation/) run, where the unreached steps *are*
reported as `skipped`.

## Adapting it

- **Make compensations idempotent.** Yours may run against a service that never
  received the original call, or one that already processed it.
- **Do not throw from a compensation for an expected condition.** "Already
  released" is success. Throwing there fills `rollbackErrors` with noise and
  marks the step `rollback-failed` for no reason.
- **Put the retry on the step that needs it.** `reserve-stock` retries because
  inventory services are flaky; the charge does not, because a declined card
  will decline three times.

## Next

- [Payment with idempotent retry](../idempotent-payment/) — why that key matters.
- [Multi-service transaction](../multi-service/) — when a compensation itself fails.
- [Rollback and compensation](../../guides/rollback/) — the full model.
