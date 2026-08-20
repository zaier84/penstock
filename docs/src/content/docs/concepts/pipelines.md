---
title: Pipelines
description: The ordered chain that threads one context through its steps, and what execute() actually returns.
sidebar:
  order: 2
---

A pipeline is an ordered, named chain of steps. It threads one context through
them, evaluates guards, fires observer hooks, owns error handling and the
rollback chain, and — when the run has settled — hands back a `Result`.

```ts
const checkout = pipeline<Order>('checkout')
  .step('validate', validateOrder)
  .step('reserve', reserveStock)
  .step('charge', chargeCard);

const result = await checkout.execute({ items, card });
```

`pipeline<TInput>(name)` fixes the input type for the whole chain, so `ctx.input`
is typed in every step. The name is validated the same way a step's is, and it
appears in `result.pipelineName`, in the pipeline's trace span, and in error
messages.

## A pipeline is a sequence of entries

Most entries are a single step. A [parallel group](../../guides/parallel/) is an
entry too: it occupies **one logical position**, so everything before it has
finished, all of its steps start together, and the next entry runs only once
every one of them has settled.

```ts
pipeline<Order>('checkout')
  .step('validate', validateOrder)            // entry 1
  .parallel([fetchStock, checkFraud, quote])  // entry 2 — one position
  .step('charge', chargeCard);                // entry 3
```

`result.steps` always lists a group's members in **declaration order**, whatever
order they finished in, so the `Result` stays deterministic.

## execute() resolves, it does not throw

`execute()` builds a **fresh context per call** and resolves with a `Result` even
when a step fails. That is the central design decision: a partial failure is
something you inspect, log, and assert on rather than a stack trace you interpret
after the fact.

```ts
const result = await checkout.execute(order);
if (!result.ok) {
  logger.error('checkout failed', serializeResult(result));
}
```

If you would rather have an exception, `{ throwOnError: true }` throws a
`PipelineError` carrying the full `.result`, the originating `.cause`, and any
rollback failures. See [Results and reporting](../results/).

`execute` also takes `dryRun`, `logger`, `signal`, `tracer`, and `parentSpan`:

| Option | Effect |
| --- | --- |
| `throwOnError` | Throw a `PipelineError` instead of returning `ok: false` |
| `dryRun` | [Plan without executing](../../guides/dry-run/) |
| `logger` | The run's [logger](../../guides/serialization/); default is a no-op |
| `signal` | [Pipeline-level cancellation](../../guides/cancellation/) |
| `tracer` | [Emit spans](../../guides/tracing/); none without it |
| `parentSpan` | Graft this run's span onto one your own code started |

## Observers and lifecycle callbacks

Two different families, and the difference matters.

**Observer hooks** fire per step. `before(ctx, step)` runs immediately before an
executed step's `run`, `after(ctx, step, { status, durationMs })` once it
completes, and `onError(error, ctx, step)` once when a step fails, **before**
rollback begins. Skipped steps fire no hooks.

**Lifecycle callbacks** fire once, at the end, after execution *and any
rollback*: `onComplete`, `onFailure`, `onCancel`, and `onSettled`. See
[Lifecycle events](../../guides/lifecycle-events/).

```ts
const checkout = pipeline<Order>('checkout')
  .step('validate', () => {})
  .step('reserve', () => ({ reservationId: 'rsv_1' }))
  .step('audit', () => {})
  .when(() => false)
  .before((_ctx, step) => console.log(`  before ${step.name}`))
  .after((_ctx, step, report) =>
    console.log(`  after  ${step.name} -> ${report.status}`),
  )
  .onComplete(() => console.log('onComplete'))
  .onSettled(() => console.log('onSettled'));

const result = await checkout.execute({ id: 'ord_1' });
console.log('ok:', result.ok, '| pipelineName:', result.pipelineName);
console.log('steps:', result.steps.map((s) => `${s.name}:${s.status}`).join(', '));
```

```text
  before validate
  after  validate -> completed
  before reserve
  after  reserve -> completed
onComplete
onSettled
ok: true | pipelineName: checkout
steps: validate:completed, reserve:completed, audit:skipped
```

Note that `audit` fired no hooks — it was skipped — but still has a report.

Both families are **observers**. A hook or callback that throws is caught, logged
at `warn`, and never alters the `Result`, re-triggers rollback, or stops the
others. Async ones are awaited.

Observer hooks are typed with a `Partial` of the accumulated state, which is
type-honest rather than pessimistic: they fire for *every* step, so at any one
firing only the keys produced so far exist. Lifecycle callbacks see the full
state, because by then the run is over.

## Engines are scoped to the pipeline

`.useEngine(engine)` registers a [named bundle of domain functions](../engines/)
that steps reach through `ctx.engines.<name>`. Scoping is per pipeline, so two
pipelines can use different engines under the same name and tests need no
teardown.

## The class API underneath

The builder is a facade. `.step(...)` constructs a `Step`, the chain constructs a
`Pipeline`, and execution, rollback, retry, timeout, cancellation, tracing, and
lifecycle events are all the same code either way. `.toPipeline()` hands you the
`Pipeline` a builder describes, fully configured:

```ts
const built = pipeline<Order>('checkout')
  .step('validate', validateOrder)
  .toPipeline();

built.addStep(extraStep); // carry on with the class API from here
```

That is the escape hatch for anything the chain cannot express — most often
building a pipeline from a list that is not known at compile time. See
[Migrating from the class API](../../migrating/).

## Next

- [Context and typed state](../context/) — the object being threaded.
- [Results and reporting](../results/) — what comes back.
- [Composition with `.compose()`](../../guides/composition/) — a pipeline as one
  step of another.
