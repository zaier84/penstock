---
title: Idempotency
description: Stable keys across retry attempts — the difference between a retry and a double charge.
sidebar:
  order: 10
---

A retried step calls the same external service twice. `idempotencyKey` gives that
service a stable token so it can recognise the second call as the **same
operation** rather than a new one.

That is the whole feature, and it is the difference between a retry and a double
charge.

## Every step already has a key

Whether or not you configure one. The default is
`` `${executionId}:${stepName}` ``:

```text
default key: <executionId>:work
```

Unique per execution and per step — safe for retries **within** a run, but
deliberately **not** stable across runs. Re-running the same order tomorrow
produces a different execution id and therefore a different key, which is exactly
what you do not want for a payment.

## Derive one from business data

Supply a string, or a function of the context:

```ts
pipeline<Order>('checkout')
  .step('charge', async (ctx, meta) => {
    await gateway.charge(ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey,
    });
  })
  .retry({ attempts: 3 })
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}:${ctx.input.amount}`);
```

Now the key survives a re-run of the same order — the gateway sees a key it has
already processed and returns the original result instead of charging again.

## Resolved once, before the first attempt

The function runs **once per step invocation**, before attempt 1, and its result
is reused unchanged for every retry. Re-deriving per attempt would defeat the
entire purpose.

```text
  attempt 1 key=charge:ord_7:2500
  attempt 2 key=charge:ord_7:2500
  undo key=charge:ord_7:2500:undo
report.idempotencyKey: charge:ord_7:2500
```

Because it is resolved before the step runs, the function sees the state as it
was **before** this step — it cannot depend on what this step produces.

## Compensations get their own key

An `undo` runs under the run key plus `:undo`, as in the output above. A
compensation and the run it reverses are therefore never confused for the same
operation by a service that deduplicates on the key. Compensations are never
retried, so their `attempt` and `maxAttempts` are both `1`.

## It is auditable from the Result

`StepReport.idempotencyKey` records the key the step actually ran under:

```ts
expect(result.steps[0]?.idempotencyKey).toBe('charge:ord_7:2500');
```

Retry-safety becomes something a test can assert on rather than something you
hope is wired correctly.

## Choosing a key

**Derive it from the identity of the operation**, not from the attempt or the
moment. A good key answers "which business action is this?" — an order id, a
transfer id, an invoice number, plus the step name to keep two different actions
on the same entity apart.

A bad key is one that changes when it should not (a timestamp, a random value,
`Date.now()`) or stays the same when it should not (a customer id alone, which
would deduplicate two genuinely different orders from the same customer).

## Do not derive it from sensitive data

A key you supply also appears in [trace attributes](../tracing/) as
`penstock.step.idempotency_key`, and in `StepReport.idempotencyKey`, which often
reaches logs via [`serializeResult`](../serialization/).

**Deriving a key from a card number or personal details therefore puts that data
in your tracing backend and your log aggregator.** Derive from identifiers. This
is the one place where the library's otherwise absolute log-hygiene guarantee
depends on a choice you make — see the [security model](../../security/).

## Validation

A non-string, an empty string, or a value that is neither a string nor a function
throws a `UsageError` when you build the pipeline. A key function that throws at
run time is a step failure, since it depends on the context.

## Next

- [Retry and backoff](../retry/) — the reason keys exist.
- [Rollback and compensation](../rollback/) — the `:undo` key in context.
- [Testing your pipelines](../testing/) — asserting on keys.
