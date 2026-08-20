---
title: Background job with cancellation and a timeout budget
description: A nightly reindex bounded two ways — a per-attempt timeout on the work, and a whole-job deadline that stops and unwinds it.
sidebar:
  order: 6
---

## The problem

A nightly job must not run into the morning. It needs two different bounds, and
conflating them is the usual mistake:

- **A per-attempt timeout**, so one wedged call does not hold the job open.
- **A whole-job deadline**, so the job as a whole gives up and cleans up.

And when either fires, the half-open index writer has to be closed and its
partial work discarded.

## The code

```ts
import { pipeline } from 'penstock';

const reindex = pipeline<JobInput>('nightly-reindex')
  .step('open-index', (ctx) => {
    marker.open = true;
    return { writer: `wr_${ctx.input.jobId}` };
  })
  .undo((ctx) => {
    marker.open = false;
    console.log(`  [job] closed and discarded ${ctx.writer}`);
  })
  .step('write-batches', async (ctx, meta) => {
    let written = 0;
    for (let i = 1; i <= ctx.input.batches; i++) {
      // The one place a long loop must cooperate: check the invocation signal.
      if (meta.signal.aborted) throw new Error('budget exhausted mid-batch');
      await sleep(batchMs, undefined, { signal: meta.signal }).catch(() => {
        throw new Error(`batch ${i} abandoned`);
      });
      written = i;
    }
    return { written };
  })
  .timeout(150) // per attempt
  .retry({ attempts: 2, delayMs: 20 })
  .step('publish', (ctx) => {
    marker.open = false;
  });
```

The deadline is supplied per run, not baked into the pipeline —
`AbortSignal.timeout` is a Node built-in, so this needs nothing extra:

```ts
const result = await reindex.execute(input, {
  signal: AbortSignal.timeout(input.budgetMs),
});
```

## The output

```text
=== 1. finishes inside its budget ===
  [job] opened writer for job_1
  [job] batch 1/3 written
  [job] batch 2/3 written
  [job] batch 3/3 written
  [job] published 3 batch(es)
  ok: true | aborted: false
    open-index     completed   attempts=1 timedOut=-
    write-batches  completed   attempts=1 timedOut=-
    publish        completed   attempts=1 timedOut=-
  index writer still open: false

=== 2. one batch is slow: the per-attempt timeout fires, then it retries ===
  [job] opened writer for job_2
  [job] batch 1/3 written
  [job] batch 1/3 written
  [job] closed and discarded wr_job_2
  ok: false | aborted: false
    open-index     rolled-back attempts=1 timedOut=-
    write-batches  failed      attempts=2 timedOut=true
  index writer still open: false

=== 3. the whole-job budget expires ===
  [job] opened writer for job_3
  [job] batch 1/20 written
  [job] batch 2/20 written
  [job] batch 3/20 written
  [job] batch 4/20 written
  [job] closed and discarded wr_job_3
  ok: false | aborted: true
    open-index     rolled-back attempts=1 timedOut=-
    write-batches  skipped     attempts=- timedOut=- cancelled
    publish        skipped     attempts=- timedOut=- cancelled
  index writer still open: false
```

## Reading it

**The two bounds produce different outcomes, and that is the point.**

Run 2 hit the **per-attempt timeout**: `timedOut: true`, `aborted: false`. One
step failed on its own budget; the run was never cancelled. Run 3 hit the
**whole-job deadline**: `aborted: true`, no `timedOut` anywhere. Branch on those
two flags and you can tell "a call wedged" from "we ran out of night".

**`batch 1/3` is written twice in run 2.** The retry restarts the loop from
the beginning. That is not a penstock behaviour — it is what a retried step
does — and it is the reason batch writes need to be idempotent, or the loop
needs to resume from `written` rather than from `1`.

**`write-batches` reports `skipped` in run 3 although it wrote four batches.**
When the pipeline's own signal has aborted, a step's failure is classified as
cancellation rather than as its own error. The status describes why the run
stopped, not how much work happened; `result.context` and your own logging are
where partial progress lives.

**The writer is closed in all three runs.** `index writer still open: false`
every time — after success via `publish`, and after both failures via the
`undo`. The compensation is what makes the job safe to re-run.

## Which signal to forward

`meta.signal` — always, in a loop like this. It fires for the step's own
timeout, for the whole-job deadline, and for a parallel peer failing.
`ctx.signal` fires for the deadline only, so a step forwarding it would ignore
its own timeout entirely. See [Cancellation](../../guides/cancellation/).

The explicit `if (meta.signal.aborted)` check at the top of each iteration is
the other half. `await`ing a signal-aware call covers the time spent waiting;
the check covers a loop whose body is CPU-bound between awaits.

## Scheduling it

penstock has no scheduler — [that is deliberate](../../getting-started/introduction/).
A cron entry, a `setInterval`, or a queue consumer calls `execute`; the pipeline
is the unit of work, not the trigger. In a queue handler, wire the handler's own
abort or lease expiry into the same `signal`.

## Compensations are not bound by the timeout

An `undo` receives the pipeline signal as its `meta.signal`, never the step's
per-attempt timeout — a cleanup must be allowed to finish. Note the flip side:
after a **cancelled** run, that signal is already aborted, so do not forward it
into the cleanup call unless you want the cleanup abandoned too.

## Next

- [Timeouts](../../guides/timeouts/) — per-attempt bounds in full.
- [Cancellation](../../guides/cancellation/) — the deadline half.
- [A pipeline inside an HTTP handler](../http-handler/) — the same wiring, request-scoped.
