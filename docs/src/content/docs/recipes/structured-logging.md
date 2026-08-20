---
title: Structured logging into an aggregator
description: One JSON record per run, with proof that the card number in the context never reaches a log line.
sidebar:
  order: 7
---

## The problem

You want one structured record per pipeline run in your aggregator: what ran,
what failed, how long it took, and why. `JSON.stringify(result)` does not
produce it — `Error.message` is non-enumerable, so errors serialize to `{}`, and
a circular reference in the context throws outright.

You also want a guarantee that the card number sitting in `ctx.input` does not
end up in Datadog.

## The code

A `Logger` is four methods, so adapting any structured logger takes four lines:

```ts
import { pipeline, serializeResult } from 'penstock';
import type { Logger } from 'penstock';

const appLogger: Logger = {
  debug: (msg, meta) => aggregator.send('debug', msg, meta ?? {}),
  info: (msg, meta) => aggregator.send('info', msg, meta ?? {}),
  warn: (msg, meta) => aggregator.send('warn', msg, meta ?? {}),
  error: (msg, meta) => aggregator.send('error', msg, meta ?? {}),
};
```

Then one record per run, from `onSettled`, with the outcome deciding the level:

```ts
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

await checkout.execute(input, { logger: appLogger });
```

`includeStacks: !result.ok` keeps successful runs small — stacks dominate the
payload and add nothing when nothing went wrong.

Separating `aborted` from failed matters more than it looks: a cancelled run is
usually a client hanging up, not a bug, and logging it at `error` is how alert
fatigue starts.

## What the library logs during the run

The input to this run is `{ orderId: 'ord_9', card: { number: '4242424242424242',
cvv: '123' } }`.

```text
=== lines the library emitted ===
  {"level":"debug","message":"step completed","stepName":"tokenize","status":"completed","durationMs":0.7835999999999785}
  {"level":"debug","message":"step failed","stepName":"charge","status":"failed","errorType":"Error","errorMessage":"gateway declined tok_4242"}

=== does anything carry the card number? ===
  "4242424242424242" appears: false
  cvv "123" appears:          false
  context present at all:     false
```

Names, statuses, durations, and error type and message. **Never `ctx.input`,
never a context value.** That is an invariant with a test in the repository
behind it, not a convention.

One honest caveat visible in that output: `gateway declined tok_4242` is *your*
error message, and penstock logs it verbatim. The library will not leak your
data, but it cannot stop you putting data into an error string.

## The settled record

```text
{
  "ok": false,
  "aborted": false,
  "executionId": "5abbb70c-1423-4139-b4c3-732ffb05ec6a",
  "pipelineName": "checkout",
  "durationMs": 18.361400000000003,
  "error": {
    "name": "StepError",
    "message": "Step \"charge\" failed",
    "cause": {
      "name": "Error",
      "message": "gateway declined tok_4242"
    },
    "stepName": "charge"
  },
  "rollbackErrors": [],
  "steps": [
    {
      "name": "tokenize",
      "status": "completed",
      "durationMs": 0.7835999999999785,
      "attempts": 1,
      "idempotencyKey": "5abbb70c-1423-4139-b4c3-732ffb05ec6a:tokenize"
    },
    ...
```

Everything an on-call engineer needs: which step, which cause, how many
attempts, and an `executionId` that correlates the record with the trace and the
`debug` lines above it.

Note that `StepError.stepName` survived. `serializeResult` keeps an error's own
custom fields, so your own error properties come through too.

## Opting into the context is explicit

```text
=== opting in is explicit, and takes everything with it ===
  context keys: input, engines, logger, signal, executionId, token
  card number now present: true
```

`includeContext: true` takes **everything**, `input` included — which is why it
is off by default. If you need one field, pull that field out; do not turn the
flag on and filter afterwards:

```ts
appLogger.error('checkout failed', {
  ...serializeResult(result),
  orderId: result.context.input.orderId, // deliberate, one field
});
```

## Querying it later

Because every record is one flat JSON object with a stable shape, the queries
that matter are cheap:

- `pipelineName:checkout AND ok:false` — failure rate per pipeline.
- `steps.status:rollback-failed` — runs that left state behind. Pair with
  `rollbackErrors` being non-empty; this is the alert worth waking someone for.
- `steps.attempts:>1` — steps that are retrying in production, which is where
  the flaky dependency is.
- `executionId:...` — one run, end to end, joined to its trace.

## Next

- [Serialization and logging](../../guides/serialization/) — the full guide.
- [Lifecycle events](../../guides/lifecycle-events/) — where `onSettled` fits.
- [Security model](../../security/) — the log-hygiene guarantee.
