---
title: Results and reporting
description: What execute() gives back — the Result fields, every step status, and the reports that make a run auditable.
sidebar:
  order: 5
---

`execute()` resolves with a `Result`. It is the whole point of the failure model:
a partial failure comes back as **data**, not as a stack trace you interpret
later.

```ts
interface Result<TContext> {
  ok: boolean; // false iff a step's run (or a guard) threw and the run aborted
  context: TContext; // final context, after execution and any rollback
  steps: StepReport[]; // one entry per step reached, in declaration order
  error: Error | null; // the failure that aborted the pipeline, if any
  rollbackErrors: Error[]; // undo() failures gathered during compensation
  aborted: boolean; // true when stopped by its AbortSignal
  executionId: string; // UUID for this call; === context.executionId
  pipelineName: string; // so a Result is self-describing once detached
  durationMs: number; // total wall-clock, rollback included
}
```

`context` is typed with everything the chain produced, so
`result.context.chargeId` is a `string`, not `string | undefined`.

## A failing run, read out

```ts
const checkout = pipeline<Order>('checkout')
  .step('validate', () => {})
  .step('reserve', () => ({ reservationId: 'rsv_1' }))
  .undo(() => {})
  .step('audit', () => {})
  .when(() => false)
  .step('charge', () => {
    throw new Error('gateway declined');
  })
  .retry({ attempts: 2 })
  .step('ship', () => {});
```

```text
ok:               false
aborted:          false
pipelineName:     checkout
error:            Step "charge" failed
error.cause:      gateway declined
error.stepName:   charge
rollbackErrors:   0
steps:
  validate  completed   attempts=1 skipReason=- error=-
  reserve   rolled-back attempts=1 skipReason=- error=-
  audit     skipped     attempts=- skipReason=guard returned false error=-
  charge    failed      attempts=2 skipReason=- error=Step "charge" failed
```

Four things to read out of that.

**`result.error` is a `StepError`.** It names the failing step and carries the
original throw, unwrapped, as `.cause`. The library never replaces your error
with a symptom of its own cleanup.

**`ship` has no report at all.** Steps after the failure were never reached, so
they are absent rather than listed as skipped. (Cancellation is different — see
below.)

**`attempts` reflects reality.** `charge` was configured with `attempts: 2` and
tried twice. A step that succeeds on its third try reports `attempts: 3`.

**`reserve` rolled back, `validate` did not.** A completed step *with* an `undo`
is compensated; one *without* declares itself to need none and stays
`completed`. See [Rollback and compensation](../../guides/rollback/).

## Step statuses

| Status | Meaning |
| --- | --- |
| `completed` | Ran successfully. Either it has no `undo`, or rollback never happened |
| `skipped` | Never ran. `skipReason` says why: a guard, cancellation, or a failed parallel peer |
| `failed` | Its `run` (or its guard) threw, after any retries. `error` is set |
| `rolled-back` | Completed, then its `undo` ran successfully during rollback |
| `rollback-failed` | Completed, but its `undo` threw. `error` is set and the throw is also in `result.rollbackErrors` |
| `would-run` | [Dry-run](../../guides/dry-run/) only: it would have run |

`skipReason` takes one of three values: `'guard returned false'`, `'cancelled'`,
or `'cancelled (parallel peer failed)'`.

## StepReport

```ts
interface StepReport {
  name: string;
  status: StepStatus;
  durationMs: number; // 0 for skipped / would-run
  error?: Error; // 'failed' and 'rollback-failed'
  skipReason?: string; // 'skipped'
  attempts?: number; // times run was called; steps that ran
  timedOut?: boolean; // the step failed on a timeout
  innerResult?: Result<any>; // nested pipelines only
  idempotencyKey?: string; // the key run was invoked under
}
```

`idempotencyKey` being on the report is what makes retry-safety **auditable
straight from the `Result`** — you can assert in a test that a charge ran under
the key you expected. `innerResult` carries a
[composed](../../guides/composition/) pipeline's entire `Result`, so a nested run
stays inspectable even when you did not map anything out of it.

## `ok`, `aborted`, and cancellation

`ok` is `false` when a step's `run` or a guard threw. `aborted` is `true` when
the run was stopped by its `AbortSignal`. A cancelled run has `ok: false` and
`aborted: true`, its completed steps roll back exactly as on a failure, and the
steps it never reached **are** reported — as `skipped` with
`skipReason: 'cancelled'`. `result.error` is the abort reason.

That flag is also what separates `onCancel` from `onFailure` in
[lifecycle events](../../guides/lifecycle-events/).

## If you would rather have an exception

```ts
try {
  await checkout.execute(order, { throwOnError: true });
} catch (err) {
  const e = err as PipelineError;
  e.result; // the full Result
  e.cause; // the originating StepError (=== result.error)
  e.rollbackErrors; // an AggregateError, when any undo failed
}
```

Nothing is lost either way — `throwOnError` wraps the same `Result` rather than
producing a different one.

## Getting a Result into your logs

`Result` holds live `Error` objects, an `AbortSignal`, and your context, so
`JSON.stringify` mangles it. `serializeResult(result)` returns a plain,
JSON-safe object, with the context excluded by default. See
[Serialization and logging](../../guides/serialization/).

## Next

- [Rollback and compensation](../../guides/rollback/) — how a step becomes `rolled-back`.
- [Serialization and logging](../../guides/serialization/) — shipping a `Result` somewhere.
- [Testing your pipelines](../../guides/testing/) — asserting on all of this.
