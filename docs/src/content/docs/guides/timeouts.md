---
title: Timeouts
description: Per-attempt timeouts, how they compose with retry, and why forwarding meta.signal is the part that actually stops the work.
sidebar:
  order: 6
---

`.timeout(ms)` bounds **a single attempt** in milliseconds. When it elapses, the
attempt rejects with a `TimeoutError`, the step is marked `failed`, and
`StepReport.timedOut` is `true`.

```ts
pipeline<Order>('checkout')
  .step('charge-payment', (ctx) => payments.charge(ctx.input.amount))
  .timeout(5000); // each attempt gets 5s
```

The value must be greater than `0`, validated when you build the pipeline.

## Per attempt, not per step

A step with `attempts: 3` and `timeout(5000)` may spend fifteen seconds in
attempts, plus backoff delays. That is deliberate: a retry exists because the
first try did not work, and giving the second try a shorter budget than the first
makes it more likely to fail for the wrong reason.

```ts
const p = pipeline<{ id: string }>('fetch')
  .step('slow-call', async (_ctx, meta) => {
    console.log(`  attempt ${meta.attempt} of ${meta.maxAttempts}`);
    await sleep(500, undefined, { signal: meta.signal });
  })
  .timeout(60)
  .retry({ attempts: 2, delayMs: 10 });
```

```text
  attempt 1 of 2
  attempt 2 of 2
ok: false
status: failed
timedOut: true
attempts: 2 | run calls: 2
cause: TimeoutError
```

If you want a budget for the whole step rather than each attempt, use a
[cancellation signal](../cancellation/) you abort yourself, or do the arithmetic
and set `timeout` to the per-attempt share.

## Forward `meta.signal` or nothing stops

This is the part that catches people out. **A timeout is a race, not an
interrupt.** penstock stops waiting for the attempt and moves on; it cannot reach
into your `await` and cancel it. Unless the work itself observes a signal, it
keeps running in the background.

```ts
.step('slow-call', async (_ctx, meta) => {
  // ✓ the fetch is actually aborted
  const res = await fetch(url, { signal: meta.signal });

  // ✗ the fetch runs to completion, ignored
  const res2 = await fetch(url);
})
```

`meta.signal` is this invocation's own signal, and it combines the step's
per-attempt timeout with the pipeline signal and — inside a parallel group — the
group's abort. It is the one to forward. `ctx.signal` is **not**: a step's
timeout does not abort it. See [Cancellation](../cancellation/) for why.

The library does guarantee one thing about abandoned work: **a run whose own
signal has aborted cannot write to the context.** An attempt that eventually
resolves long after its timeout will not mutate a context the pipeline has
already moved past.

## Timeouts and rollback

A timed-out step is `failed`, so rollback proceeds as usual: everything completed
before it is compensated in reverse order, and the timed-out step is not.

Compensations are **not** bound by the step's timeout — an `undo` receives the
pipeline signal as its `meta.signal`, because a compensation must be allowed to
finish. A timeout that also killed the cleanup would be the worst possible
behaviour.

## Reading it from the Result

```ts
result.steps[0]?.timedOut; // true
result.error?.cause; // a TimeoutError
```

`timedOut` distinguishes a timeout from any other failure without string-matching
the error, which is what you want when deciding whether to alert.

## Choosing a value

Set the timeout **above the dependency's realistic worst case**, not near its
median. A timeout tuned to the p50 turns a slow day into an outage. If you do not
know the distribution, start generous, measure `StepReport.durationMs` across
real runs, then tighten.

A step with no timeout waits indefinitely, bounded only by the pipeline's
cancellation signal. For anything crossing a network, that is rarely what you
want.

## Testing timeouts

Fake timers do **not** control them: the per-attempt timeout uses
`AbortSignal.timeout()`, which is not routed through the `setTimeout` that fake
timers replace. Use a real, small timeout in tests instead — 20ms is plenty. See
[Testing your pipelines](../testing/).

## Next

- [Retry and backoff](../retry/) — what a timeout composes with.
- [Cancellation](../cancellation/) — `meta.signal` versus `ctx.signal`.
- [Results and reporting](../../concepts/results/) — where `timedOut` lives.
