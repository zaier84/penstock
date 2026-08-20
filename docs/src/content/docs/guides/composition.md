---
title: Composition with .compose()
description: Nest a whole pipeline as a single step, with typed data flowing in through mapInput and out through mapResult.
sidebar:
  order: 3
---

`.compose(name, inner, options)` nests a pipeline as **one step** of an outer
one, so workflows compose hierarchically instead of flattening into a single
hundred-step chain.

The inner pipeline runs on its **own fresh, isolated context**. `mapInput`
derives its input from the outer context — the only way in — and `mapResult`
returns a contribution that is merged onto the outer context, the way out.

```ts
const inventory = pipeline<{ items: string[] }>('check-inventory')
  .step('lookup', (ctx) => ({ warehouse: `wh_${ctx.input.items.length}` }))
  .step('reserve', (ctx) => ({ reservationId: `rsv_${ctx.warehouse}` }));

const checkout = pipeline<Order>('checkout')
  .step('validate', () => {})
  .compose('run-inventory', inventory, {
    mapInput: (ctx) => ({ items: ctx.input.items }),
    // Returns a contribution; the accumulated type follows it.
    mapResult: (inner) => ({ reservationId: inner.context.reservationId }),
  })
  .undo((ctx) => {
    console.log(`releasing ${ctx.reservationId}`);
  })
  .step('charge', (ctx) => {
    throw new Error(`gateway declined for ${ctx.reservationId}`);
  });
```

```text
releasing rsv_wh_2
ok: false
error cause: gateway declined for rsv_wh_2
outer steps: validate:completed, run-inventory:rolled-back, charge:failed
inner pipelineName: check-inventory
inner steps: lookup:completed, reserve:completed
inner is a separate execution: true
```

`ctx.reservationId` is a `string` in both `charge` and the `undo`, because
`mapResult` **returned** it. That is the one place this differs from the class
API's `asStep`, whose `mapResult` returns `void` and writes onto the outer
context by hand — which the type system cannot follow.

Omitting `mapResult` contributes nothing while still running the inner pipeline
for its effects. `mapResult` may be async; its resolved value is what merges.

## Two rollback chains, kept separate

**The inner pipeline fails.** It rolls back its own completed steps internally,
and the wrapping step reports `failed`. The outer pipeline then rolls back its
own prior steps. Inner undos are never run twice, and `mapResult` is not called
at all:

```text
  inner: undo lookup
  outer: undo validate
ok: false
outer steps: validate:rolled-back, run-inventory:failed
inner steps: lookup:rolled-back, reserve:failed
mapResult ran: false
```

**The inner pipeline succeeds and a later outer step fails.** The inner work is
committed, so the outer rollback runs the `undo` you chained after `.compose()` —
as in the first example, where `releasing rsv_wh_2` printed. Reversing an entire
pipeline's net effect is that function's job, because only you know what it
means. Without an `undo`, the wrapping step stays `completed`.

**The outer run is cancelled mid-inner-execution.** The signal propagates in, the
inner pipeline stops between its steps and rolls back, and the wrapping step
reports `skipped`.

## What crosses the boundary, and what does not

| Crosses in | Does not |
| --- | --- |
| The input `mapInput` derives | The outer **context** — the inner one is fresh |
| The outer run's `logger` | The outer pipeline's **engines** |
| The outer run's cancellation `signal` | The outer `executionId` — the inner run gets its own |
| The wrapping step's trace span, as the inner pipeline span's parent | |

Engines not crossing is deliberate: the inner pipeline resolves its own
`useEngine` registrations, so it is self-contained and testable on its own.
Register what it needs on the inner pipeline.

## The inner Result is always available

The wrapping step's report carries the entire inner `Result` as
`StepReport.innerResult`, whether or not you mapped anything out of it:

```ts
const wrapper = result.steps.find((s) => s.name === 'run-inventory');
wrapper?.innerResult?.steps; // the inner run, step by step
wrapper?.innerResult?.executionId; // its own id
```

The outer `steps[]` stays flat, so a nested run never distorts the shape of the
outer report.

## Composing a class-API pipeline

`inner` may be a typed pipeline or a class-API `Pipeline`; the overloads accept
either. On the class API the equivalent is `innerPipeline.asStep(name, options)`,
whose options also carry `undo` and `when` inline rather than as chained
modifiers. See [Migrating from the class API](../../migrating/).

## When to compose instead of just adding steps

Reach for it when the inner flow is **independently meaningful** — it has its own
name in your domain, its own tests, and its own rollback semantics. If it is just
three more steps in the same transaction, add three more steps: composition costs
you a second execution id and a mapping layer, and buys nothing when there is
nothing to isolate.

## Next

- [Rollback and compensation](../rollback/) — the semantics being nested.
- [Results and reporting](../../concepts/results/) — `innerResult` in context.
- [Tracing and observability](../tracing/) — nested spans.
