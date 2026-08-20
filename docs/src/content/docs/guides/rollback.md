---
title: Rollback and compensation
description: Reverse-order, best-effort compensation — what runs, what does not, and what happens when a compensation itself fails.
sidebar:
  order: 4
---

This is penstock's standout feature. When a step's `run` throws, the pipeline
**aborts the flow and walks backwards** through the steps that already completed,
running each one's `undo`.

```ts
const checkout = pipeline<Order>('checkout')
  .step('audit', () => {
    console.log('audit written');
  })
  .step('reserve', () => ({ reservationId: 'rsv_1' }))
  .undo((ctx) => {
    console.log(`release ${ctx.reservationId}`);
  })
  .step('charge', () => ({ chargeId: 'chg_1' }))
  .undo(() => {
    throw new Error('refund endpoint timed out');
  })
  .step('ship', () => {
    throw new Error('carrier rejected the shipment');
  });
```

```text
audit written
release rsv_1
ok: false
error: Step "ship" failed
cause: carrier rejected the shipment
  audit    completed
  reserve  rolled-back
  charge   rollback-failed
  ship     failed
rollbackErrors: [ 'refund endpoint timed out' ]
```

Everything about the model is in that output.

## The four rules

**Compensations run in reverse order.** `charge` was compensated before
`reserve`, mirroring the order they ran in. You did not write that ordering; it
falls out of where the `.undo()` calls sit in the chain. It matters: releasing a
reservation before refunding the charge against it is the wrong order in most
domains.

**Rollback is best-effort and independent.** The refund threw. `reserve` was
compensated anyway. A failing compensation is **recorded, not propagated** — one
broken endpoint can never strand the resources the other compensations would
release. That is the single most important difference from a hand-written
`catch` block, where the first failing cleanup call aborts the rest.

**A step with no `undo` needs none.** `audit` stayed `completed` rather than
being marked rolled back. Declaring no compensation is a statement that the step
has nothing to reverse.

**The failing step is not compensated.** `ship` is `failed`. Its `run` threw, so
whatever it was going to do did not finish; compensating it would mean undoing
work that never happened. If your step does part of its work before throwing,
that part is yours to make idempotent — see [Idempotency](../idempotency/).

## Where failures end up

`result.error` is a `StepError` naming the step, with the original throw
preserved as `.cause`. It is **not** replaced by the compensation failure — the
thing that actually went wrong stays the headline.

Compensation failures go to `result.rollbackErrors`, and the step that produced
one is `rollback-failed` with its `error` set. So a `Result` distinguishes three
different bad outcomes that a thrown exception would flatten into one: the
operation failed, the cleanup failed, or both.

## `undo` sees a required context

`.undo()` chains onto the step it compensates and sees that step's output as
**required**, because a compensation only ever runs for a step that completed:

```ts
  .step('charge-card', async (ctx) => ({ chargeId: await charge(ctx.reservationId) }))
  .undo(async (ctx) => refund(ctx.chargeId)) // string — no `!`, no `if`
```

It also receives `meta`, whose `idempotencyKey` is the run key plus `:undo`, so a
compensation and the run it reverses are never confused for the same operation by
an external service. `attempt` and `maxAttempts` are both `1`: **compensations
are never retried.** If yours needs to be resilient, make it resilient inside the
function.

`meta.signal` for an `undo` is the pipeline signal, not the step's per-attempt
timeout — a compensation must be allowed to finish.

## Cancellation rolls back too

An aborted run compensates its completed steps exactly like a failure: reverse
order, best-effort. The difference is `result.aborted === true` and
`result.error` being the abort reason. See [Cancellation](../cancellation/).

## Rollback inside parallel groups and nested pipelines

A [parallel group's](../parallel/) completed steps are rolled back in **reverse
declaration order**, before the entries that preceded the group.

A [composed](../composition/) inner pipeline rolls back its own steps when it
fails, and the wrapping step reports `failed`. When the inner pipeline succeeded
and a later outer step fails, the inner work is committed and the `undo` you
chained after `.compose()` is what reverses it.

## If you prefer exceptions

```ts
try {
  await checkout.execute(order, { throwOnError: true });
} catch (err) {
  const e = err as PipelineError;
  console.log('cause:', (e.cause as Error).message);
  console.log('bundled:', e.rollbackErrors?.errors.map((x: Error) => x.message));
}
```

```text
name: PipelineError
message: Pipeline "checkout" failed
cause: Step "ship" failed
result.ok: false
rollbackErrors is AggregateError: true
bundled: [ 'release failed' ]
```

Rollback failures arrive as a native `AggregateError`, and `e.result` is the same
`Result` you would have got back.

## Designing compensations

- **Make them idempotent.** A compensation may run against a service that already
  processed the original call, or that never received it.
- **Do not let them throw for expected conditions.** "Already released" is
  success, not failure — throwing there fills `rollbackErrors` with noise.
- **Keep them narrow.** An `undo` reverses *its* step, not the whole operation.
  The reverse-order walk composes the individual reversals for you.
- **Do not put business logic in them.** A compensation that decides whether to
  refund is a step; one that refunds is an `undo`.

## Next

- [Idempotency](../idempotency/) — making retries and compensations safe.
- [Cancellation](../cancellation/) — the other path into rollback.
- [Testing your pipelines](../testing/) — forcing a failure to prove it works.
