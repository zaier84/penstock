---
title: Retry and backoff
description: Per-step retry policy — attempt counting, fixed and exponential backoff, jitter, and what is deliberately not retried.
sidebar:
  order: 5
---

Give a step a `retry` policy and its `run` is re-invoked on failure.

```ts
pipeline<Order>('sync')
  .step('fetch-inventory', async (ctx) => ({
    inventoryToken: await inventory.reserve(ctx.input.items),
  }))
  .retry({ attempts: 3, delayMs: 500, backoff: 'exponential' });
```

## `attempts` counts the first try

`attempts: 3` means **one try plus up to two retries**, not three retries. The
minimum is `1`, which means no retry at all. A value below `1` throws a
`UsageError` when you build the pipeline, not at run time.

This is the option people misread most often, so the library counts it the way
the `StepReport` reports it: a step that succeeded on its third try reports
`attempts: 3`.

```ts
const p = pipeline<{ id: string }>('sync')
  .step('flaky', () => {
    calls += 1;
    if (calls < 3) throw new Error(`upstream 503 (attempt ${calls})`);
    return { synced: true };
  })
  .retry({ attempts: 4, delayMs: 100, backoff: 'exponential' });
```

```text
  attempt 1, waited ~0ms
  attempt 2, waited ~100ms
  attempt 3, waited ~200ms
ok: true
report.attempts: 3
synced: true
```

Four attempts were allowed, three were used, and the report says three.

## Backoff

| Option | Default | Effect |
| --- | --- | --- |
| `delayMs` | `0` | Base delay between attempts; must be `>= 0` |
| `backoff` | `'fixed'` | `'fixed'` keeps every delay at `delayMs`; `'exponential'` doubles it after each failure |
| `jitter` | `false` | Adds a uniform random fraction of the computed delay |

Exponential delay is `delayMs * 2^attemptIndex`, which is the `100`, `200` in the
run above.

**Use `jitter` whenever many callers can fail simultaneously.** A shared
dependency that goes down takes every caller with it, and without jitter they all
retry at the same instant and knock it over again as it recovers. Jitter spreads
the retry storm out.

## When the budget runs out

```text
ok: false
attempts: 3
status: failed
error: Step "always-fails" failed
cause: upstream 503
```

The step is `failed`, `result.error` is a `StepError`, and its `.cause` is the
**last** attempt's error. The earlier attempts' errors are not retained; if you
need them, log them from inside the step using `meta.attempt`.

Rollback then proceeds normally — the failing step is not compensated, and
everything completed before it is. See [Rollback](../rollback/).

## Only `run` is retried

Guards and compensations are **never** retried. A guard is a pure predicate, and
a `undo` gets exactly one shot — its `meta.attempt` and `meta.maxAttempts` are
both `1`. If a compensation needs resilience, build it into the function.

## A retried step calls the service twice

That is the entire point, and it is also the risk. A retried charge is a double
charge unless the service can recognise the second call as the same operation.
`meta.idempotencyKey` is stable across every attempt of a step for exactly this
reason:

```ts
  .step('charge', async (ctx, meta) => {
    await gateway.charge(ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey, // identical on attempts 1, 2 and 3
    });
  })
  .retry({ attempts: 3 })
```

Read [Idempotency](../idempotency/) before adding retry to anything that spends
money or creates records.

## Retry composes with timeout

`.timeout(ms)` applies **per attempt**, so each try gets the full budget. A step
with `attempts: 3` and `timeout(5000)` can take fifteen seconds of attempts plus
the backoff delays. See [Timeouts](../timeouts/).

## What not to retry

- **Anything that is not transient.** A `400`, a validation failure, or a
  business rule rejection will fail identically three times. Retry is for
  timeouts, `5xx`s, connection resets, and lock contention.
- **Long operations with no idempotency key.** The retry may run concurrently
  with an original call that is still in flight on the server.
- **Steps whose failure you want to see quickly.** Retries delay the rollback of
  everything before them.

penstock does not inspect your error to decide whether to retry — it retries
whatever throws. To retry selectively, catch the non-retryable cases inside the
step and convert them into a different outcome, or split the step in two.

## Cancellation wins

If the pipeline's signal aborts during a backoff delay, the delay wakes
immediately and the run stops rather than waiting it out. See
[Cancellation](../cancellation/).

## Testing retry

Fake timers work, because inter-attempt delays use `setTimeout` from
`node:timers/promises`:

```ts
vi.useFakeTimers();
const running = flaky.execute(order);
await vi.advanceTimersByTimeAsync(3000);
const result = await running;
expect(result.steps[0]?.attempts).toBe(3);
```

See [Testing your pipelines](../testing/), which also explains why the same trick
does **not** work for timeouts.

## Next

- [Timeouts](../timeouts/) — bounding each attempt.
- [Idempotency](../idempotency/) — making retries safe.
- [Testing your pipelines](../testing/) — asserting on attempt counts.
