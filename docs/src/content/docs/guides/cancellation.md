---
title: Cancellation
description: Stopping a run with an AbortSignal, and the difference between ctx.signal and meta.signal that everything else depends on.
sidebar:
  order: 7
---

Pass an `AbortSignal` to `execute` and the pipeline stops when it aborts.

```ts
const controller = new AbortController();
const result = await checkout.execute(order, { signal: controller.signal });
// ...elsewhere: controller.abort(new Error('customer cancelled'));
```

The signal is checked **between steps**. A step already running is never
interrupted mid-flight by the pipeline itself; the next between-step check stops
the run. On cancellation, completed steps are **rolled back** exactly like a
failure — reverse order, best-effort — the abort reason becomes `result.error`,
and `result.aborted` is `true`.

```text
released rsv_1
ok: false | aborted: true
error: customer cancelled
  reserve     rolled-back
  long-write  completed
  never-runs  skipped     cancelled
```

Read that carefully: `long-write` was running when the abort fired and still
reports `completed`, because it finished before the next check. Steps never
reached report `skipped` with `skipReason: 'cancelled'` — unlike a step failure,
where later steps get no report at all.

## The two signals

There are two signals inside a step, and the distinction is the single most
confusing thing in the library. It is worth getting right once.

### `meta.signal` — this invocation

Created fresh **per attempt**. It combines three things:

- the step's own per-[attempt timeout](../timeouts/), if it has one,
- its [parallel group's](../parallel/) abort, if it is in one,
- the pipeline signal.

**This is the one to forward into your own async work.** It is the only signal
that knows about the step's timeout, so forwarding anything else means your
timeout does not actually stop anything.

```ts
pipeline<Job>('reindex').step('reindex', async (ctx, meta) => {
  for (const batch of batches) {
    if (meta.signal.aborted) return; // cancellation, timeout, or peer failure
    await indexer.write(batch, { signal: meta.signal });
  }
});
```

### `ctx.signal` — the whole run

The **pipeline-level** signal, and only that. It answers one question: "was the
entire run cancelled?" A step's timeout does not abort it, and a parallel peer's
failure does not either.

It is bound once when the context is created and never reassigned, which makes it
safe to read from anywhere — including from several concurrently running steps of
a parallel group.

### They really are different objects

```ts
.step('with-timeout', async (ctx, meta) => {
  await sleep(200, undefined, { signal: meta.signal }).catch(() => {
    console.log('after timeout -> meta.signal.aborted:', meta.signal.aborted);
    console.log('after timeout -> ctx.signal.aborted :', ctx.signal.aborted);
    throw new Error('gave up');
  });
})
.timeout(50);
```

```text
after timeout -> meta.signal.aborted: true
after timeout -> ctx.signal.aborted : false
ok: false | aborted: false
timedOut: true
```

The step's timeout aborted `meta.signal` and left `ctx.signal` untouched — and
`result.aborted` is `false`, because the *run* was never cancelled. One step
timing out is a step failure, not a cancellation.

### Which to use

**Default to `meta.signal`.** Forward it into every network call, every long
loop, every `sleep`. It is a superset: it fires for cancellation *and* for
timeouts *and* for parallel peer failures.

Reach for `ctx.signal` only when you specifically want "is the whole run
cancelled" and want to ignore this step's own timeout — for example, deciding
whether to write a final audit record.

### Why not one signal

One shared `ctx.signal` could never be the per-attempt timeout signal of several
concurrently running steps at once. Before `0.4.0` there was only `ctx.signal`,
and a step inside a parallel group had no way to observe its own timeout at all.
`meta.signal` being per invocation is what fixes that.

If you are upgrading from `0.3.x`: **`ctx.signal` no longer aborts when a step's
own `timeout` fires — use `meta.signal`.** If a step forwarded `ctx.signal` to
honour its timeout, change it. `ctx.signal` keeps working for "was the pipeline
cancelled". Everything else is additive.

## Compensations get the pipeline signal

An `undo`'s `meta.signal` is `ctx.signal`, not the step's timeout signal — a
compensation must be allowed to finish. Note that this means a compensation runs
under an **already-aborted** signal when the run was cancelled, so do not forward
it into the cleanup call unless you want that cleanup abandoned immediately.

## Aborting during a retry delay

An abort during a backoff delay wakes it immediately rather than waiting it out,
and the run stops there. See [Retry and backoff](../retry/).

## Wiring in a request signal

The common case is an HTTP handler whose client disconnected:

```ts
app.post('/checkout', async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => controller.abort(new Error('client disconnected')));

  const result = await checkout.execute(req.body, { signal: controller.signal });
  res.status(result.ok ? 200 : 500).json(serializeResult(result));
});
```

The run stops, completed steps compensate, and you get a `Result` describing
exactly how far it got — rather than a half-finished order and no record of it.

## Telling cancellation apart afterwards

`result.aborted` is the flag. It separates `onCancel` from `onFailure` in
[lifecycle events](../lifecycle-events/), and it is what you branch on when
deciding whether a failure deserves an alert. A cancelled run is usually not a
bug.

## Next

- [Timeouts](../timeouts/) — the other thing that aborts `meta.signal`.
- [Parallel groups](../parallel/) — the third.
- [Rollback and compensation](../rollback/) — what cancellation triggers.
