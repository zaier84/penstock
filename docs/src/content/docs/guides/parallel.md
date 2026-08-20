---
title: Parallel groups and concurrency
description: Running independent steps concurrently, capping how many run at once, and what happens to the group when one of them fails.
sidebar:
  order: 8
---

`.parallel([...])` runs independent step definitions **concurrently**. The group
occupies a single logical position: everything before it has finished, all of its
steps start together, and the next entry runs only once every one of them has
settled.

```ts
const forOrder = defineStep<Order>();
const fetchInventory = forOrder('fetch-inventory', async (ctx) => ({
  inventoryToken: await inventory.reserve(ctx.input.items),
}));
const checkFraud = forOrder('check-fraud', async () => ({ fraudScore: 0.02 }));
const fetchPricing = forOrder('fetch-pricing', async () => ({ price: 2500 }));

const checkout = pipeline<Order>('checkout')
  .step('validate-order', validateOrder)
  .parallel([fetchInventory, checkFraud, fetchPricing]) // concurrent
  .step('charge-payment', chargePayment);
```

Every definition's contribution is merged into the accumulated type, so
`charge-payment` sees `ctx.inventoryToken`, `ctx.fraudScore` and `ctx.price` all
at once.

```text
start order : a, b, c
report order: prepare, a, b, c, collect
elapsed ~ 80 ms (not 120 — they overlapped)
```

Three steps sleeping 60ms, 40ms and 20ms took about as long as the slowest, not
their sum. And `result.steps` lists them in **declaration** order regardless of
which finished first, so the `Result` stays deterministic.

## It takes an array, on purpose

Not an object keyed by name. Declaration order decides rollback order and which
failure becomes `result.error`, and JavaScript reorders integer-like keys in
objects — so an object form would silently reorder a group containing a step
named `"1"`. An array cannot do that.

Groups need **at least two** definitions. Modifiers belong on the individual
definitions, not on the group: `.retry()` straight after `.parallel()` throws a
`UsageError`, because a modifier targets a single step.

```ts
.parallel([
  fetchInventory.retry({ attempts: 3 }), // ✓ on the definition
  checkFraud.timeout(2000),
])
```

## Concurrency limits

A fan-out of fifty steps opening fifty connections at once is rarely what you
want. `{ concurrency: n }` runs at most `n` at a time, the rest waiting in a
bounded pool that dispatches **in declaration order** as slots free.

```ts
pipeline<Order>('checkout').parallel(
  [fetchInventory, checkFraud, fetchPricing, fetchShippingRates],
  { concurrency: 2 }, // two in flight; the other two queue
);
```

```text
ok: true
peak concurrent steps: 2 (cap was 2)
```

The limit must be an integer `>= 1`, validated when you build the pipeline — a
bad value throws `UsageError` immediately, not at run time. Omitting it, or
setting it at or above the group size, runs everything at once.

## When one step fails

The group **cancels its peers**, then unwinds:

1. The failing step's own retries are exhausted first.
2. The group's signal aborts, so in-flight peers observing `meta.signal` can stop
   early. A peer still **queued** under a concurrency cap is never dispatched —
   its `run` is not called at all.
3. Every step is awaited to settlement (`Promise.allSettled`, never fail-fast).
4. The group's completed steps roll back in **reverse declaration order**,
   followed by the pipeline steps before the group.

```text
  watcher observed the group abort
  undo ok-step
  undo before
ok: false
error: Step "boom" failed
  before    rolled-back
  ok-step   rolled-back
  boom      failed
  watcher   failed
```

`result.error` is the **first** failure in declaration order, and every failure
keeps its own `StepReport.error`, so a group that fails twice does not lose the
second one.

A peer stopped by the group abort reports `skipped`:

```text
  boom    failed
  queued  skipped  cancelled (parallel peer failed)
```

Note the difference between the two runs above. `watcher` observed the abort and
**threw its own error**, so it is `failed`. `queued` never started, so it is
`skipped` with a `skipReason`. If you want a cancelled peer to report as skipped,
return from it rather than throwing when `meta.signal.aborted`.

## Guards run before anything launches

Guards are evaluated **sequentially, in declaration order, before any step
starts**. A guard-skipped step never occupies a concurrency slot. This is also
what lets [dry-run](../dry-run/) plan a group without executing it.

## Give every step its own output key

All parallel steps share the same mutable context. Steps writing **distinct**
keys are safe. Two writing the **same** key race, and the types cannot catch it
when both produce the same type. This is the one real hazard of the group, and it
is covered in full in [Context and typed state](../../concepts/context/).

## Retry, timeout, undo, and hooks all work

Inside a group they behave exactly as they do sequentially. The only difference
is `meta.signal`, which additionally carries the group's abort — which is
precisely why forwarding `meta.signal` rather than `ctx.signal` matters here. See
[Cancellation](../cancellation/).

## When not to use a group

If the steps are not genuinely independent — if one reads a key another produces
— they are sequential steps. The type system will usually tell you, since a
group's members all see the state as it was *before* the group.

## Next

- [Reusable steps with `defineStep`](../define-step/) — groups take definitions.
- [Cancellation](../cancellation/) — the group's abort signal.
- [Context and typed state](../../concepts/context/) — the write-isolation caveat.
