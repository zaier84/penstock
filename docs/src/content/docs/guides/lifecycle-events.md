---
title: Lifecycle events
description: The four pipeline-scoped callbacks that fire once a run has fully settled, and how they differ from per-step hooks.
sidebar:
  order: 9
---

Four callbacks observe a run **once it has fully settled** — after execution and
any rollback. All are chainable, all can be registered more than once (they run
in registration order), and all receive the final `Result`.

```ts
const checkout = pipeline<Order>('checkout')
  .step('validate', validate)
  .step('charge', charge)
  .onComplete((result) => metrics.emit('order.success', result))
  .onFailure((result) => metrics.emit('order.failure', result))
  .onCancel((result) => metrics.emit('order.cancel', result))
  .onSettled((result) => audit.log('order.settled', result));
```

| Callback | Fires when |
| --- | --- |
| `onComplete` | The run succeeded (`result.ok === true`) |
| `onFailure` | A step or guard failed — **after** rollback is complete |
| `onCancel` | The run was stopped by its `AbortSignal` (`result.aborted === true`), after rollback |
| `onSettled` | **Always**, and last: the `finally` of the family |

`result.aborted` is what separates `onCancel` from `onFailure`. A cancelled run
never fires `onFailure`, and a failed run never fires `onCancel`.

## After rollback, not before

```ts
const build = (fail: boolean) =>
  pipeline<Job>('job')
    .step('prepare', () => ({ prepared: true }))
    .undo(() => {
      console.log('  undo prepare');
    })
    .step('work', () => {
      if (fail) throw new Error('boom');
    })
    .onComplete(() => console.log('  onComplete'))
    .onFailure((r) => console.log('  onFailure, after rollback:', r.steps[0]?.status))
    .onCancel((r) => console.log('  onCancel, aborted =', r.aborted))
    .onSettled((r) => console.log('  onSettled, ok =', r.ok));
```

```text
success:
  onComplete
  onSettled, ok = true
failure:
  undo prepare
  onFailure, after rollback: rolled-back
  onSettled, ok = false
cancellation:
  onCancel, aborted = true
  onSettled, ok = false
```

`onFailure` sees `prepare` already `rolled-back`. That ordering is what makes
these callbacks useful for metrics and audit: by the time they fire, the run is
genuinely over and the `Result` is final.

## They are observers, and cannot change anything

A callback that throws is **caught, logged at `warn`, and ignored**:

```text
a throwing callback is contained:
  onSettled still fired
  result.ok: true | result.error: null
```

The failing `onComplete` did not fail the run, did not stop `onSettled`, and left
`result.error` as `null`. Async callbacks are awaited, so a slow one delays the
`execute()` promise — but it still cannot change the outcome.

That containment is the same one that governs observer hooks and tracer calls: a
broken observer must never take a working pipeline down with it.

## Lifecycle callbacks versus observer hooks

| | Fires | Sees |
| --- | --- | --- |
| `before` / `after` / `onError` | Once **per step** | `Partial` of the accumulated state |
| `onComplete` / `onFailure` / `onCancel` / `onSettled` | Once **per run**, at the end | The full state, and the final `Result` |

`onError` and `onFailure` are easy to confuse. `onError` is a per-step hook that
fires **before** rollback begins, with the error, the context, and the step.
`onFailure` is a lifecycle callback that fires **after** rollback, with the
`Result`. Use `onError` to observe the moment of failure; use `onFailure` to
report the outcome.

The `Partial` typing on hooks is type-honest: they fire for every step, so at any
one firing only the keys produced so far exist.

## Dry-run fires nothing

A [dry-run](../dry-run/) plans without executing, so no lifecycle callback and no
observer hook fires. Planning is not a run.

## What to put in them

- **Metrics and audit.** The natural home: one place per pipeline rather than a
  counter at every call site.
- **Alerting decisions.** Branch on `result.aborted` so a cancelled run does not
  page anyone.
- **Structured logging.** `onSettled` with
  [`serializeResult`](../serialization/) gives you one JSON-safe record per run.

What not to put in them: anything the run's correctness depends on. They are
observers, their throws are swallowed, and a compensating action belongs in an
`undo`.

## Next

- [Rollback and compensation](../rollback/) — what has already happened when `onFailure` fires.
- [Serialization and logging](../serialization/) — what to log from `onSettled`.
- [Tracing and observability](../tracing/) — the other observation surface.
