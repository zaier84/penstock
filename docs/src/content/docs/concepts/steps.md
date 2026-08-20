---
title: Steps
description: The atomic unit of work — what a step receives, what it returns, and the modifiers that chain onto it.
sidebar:
  order: 1
---

A step is a named function that receives the shared context, does one piece of
work, and **returns what it produced**. That return value is merged onto the
context, which is what makes the next step's types grow.

```ts
pipeline<Signup>('onboarding').step('create-account', async (ctx) => ({
  accountId: await accounts.create(ctx.input.email),
}));
```

The name is not decoration. It appears in `result.steps`, in log lines, in trace
spans, and in the default idempotency key — it is how this unit of work is
identified everywhere the run is observed. Names are validated and de-duplicated
when you declare them, so a blank or duplicate name throws a `UsageError` at the
`.step()` call rather than at run time.

## What a step returns

Returning an object contributes those keys to the context. Returning nothing
contributes nothing, which is the normal case for a step that only validates or
only calls out:

```ts
.step('validate', (ctx) => {
  if (!ctx.input.email.includes('@')) throw new Error('not an email address');
})
```

Returning a key that already exists **overwrites** it, exactly as an assignment
would, and the accumulated type overwrites with it.

What you cannot return is anything that is not a plain object — an array, a
function, a primitive, a `Date`, a class instance. Those throw a `UsageError`
from inside the step, which surfaces as an ordinary step failure and triggers
rollback like any other. Nor can you return one of the five context fields
penstock owns (`input`, `engines`, `logger`, `signal`, `executionId`), or a key
named `__proto__`, `prototype`, or `constructor`. See
[Context and typed state](../context/) for why that guard exists.

## The second argument

Every `run` and `undo` receives `meta`, describing **this invocation** — which
the shared context cannot, because one context is threaded through the whole run
and shared by the concurrent steps of a parallel group.

```ts
.step('charge-payment', async (ctx, meta) => {
  meta.stepName;       // 'charge-payment'
  meta.pipelineName;   // 'checkout'
  meta.executionId;    // UUID for this execute() call
  meta.attempt;        // 1-based attempt number
  meta.maxAttempts;    // total tries allowed (1 when no retry)
  meta.idempotencyKey; // stable across every attempt
  meta.signal;         // this invocation's own AbortSignal

  await gateway.charge(ctx.input.amount, {
    idempotencyKey: meta.idempotencyKey,
    signal: meta.signal,
  });
})
```

Declaring fewer parameters stays valid — a one-argument `run` is unaffected.
Guards deliberately receive **no** metadata: they are contractually pure
predicates that [dry-run](../../guides/dry-run/) relies on evaluating safely, and
an attempt number would invite side-effectful guards.

## Modifiers chain after the step

`when`, `undo`, `retry`, `timeout`, and `idempotencyKey` are chained calls that
apply to the step above them:

```ts
pipeline<Order>('checkout')
  .step('reserve-stock', async (ctx) => ({
    reservationId: await reserve(ctx.input.items),
  }))
  .undo(async (ctx) => release(ctx.reservationId)) // required — no `!`
  .retry({ attempts: 3, backoff: 'exponential' })
  .timeout(5000)
  .idempotencyKey((ctx) => `reserve:${ctx.input.orderId}`);
```

The ordering is not cosmetic. Typing `undo` from inside an options object
alongside `run` would require inferring the run's return type in order to type a
sibling property of the same object literal, which is circular. Chaining is
exactly what lets `ctx.reservationId` be **required** inside `undo`.

Applying a modifier twice **replaces** the earlier value rather than combining.
Calling one before any step, or straight after `.parallel(...)`, throws a
`UsageError` — a modifier targets a single step, and a group is not one.

| Modifier | Effect | Guide |
| --- | --- | --- |
| `.when(fn)` | Skips the step when the predicate is falsy; its contribution becomes optional downstream | [Dry-run](../../guides/dry-run/) |
| `.undo(fn)` | Compensation, run during reverse-order rollback | [Rollback](../../guides/rollback/) |
| `.retry(options)` | Re-invokes `run` on failure, with backoff | [Retry](../../guides/retry/) |
| `.timeout(ms)` | Bounds a single attempt | [Timeouts](../../guides/timeouts/) |
| `.idempotencyKey(key)` | Stable token across retries | [Idempotency](../../guides/idempotency/) |

## How a step ends up in the Result

Every step that the pipeline reached gets one entry in `result.steps`, in
declaration order:

```ts
const result = await onboarding.execute({
  email: 'ada@example.com',
  plan: 'free',
});

for (const step of result.steps) {
  console.log(
    `${step.name.padEnd(15)} ${step.status.padEnd(10)} ` +
      `attempts=${step.attempts ?? '-'} skipReason=${step.skipReason ?? '-'}`,
  );
}
```

```text
validate        completed  attempts=1 skipReason=-
create-account  completed  attempts=1 skipReason=-
start-trial     skipped    attempts=- skipReason=guard returned false
```

A skipped step has no `attempts`, because its `run` was never called. The full
set of statuses is in [Results and reporting](../results/).

## Reusing a step

A step declared inline belongs to its pipeline. To declare one **once** and use
it in several pipelines, use `defineStep`, which also lets a step declare the
prior state it requires:

```ts
const forOrder = defineStep<Order>();
const fetchPricing = forOrder('fetch-pricing', async (ctx) => ({
  price: await pricing.quote(ctx.input.items),
}));

pipeline<Order>('checkout').use(fetchPricing);
```

[Reusable steps with `defineStep`](../../guides/define-step/) covers the two-stage
call, declared requirements, and deriving specialised variants.

## Next

- [Pipelines](../pipelines/) — how steps are ordered, and what `execute()` does.
- [Context and typed state](../context/) — where a step's return actually goes.
- [Rollback and compensation](../../guides/rollback/) — what `undo` is for.
