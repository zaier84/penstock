---
title: Context and typed state
description: The single mutable object threaded through a run, why it is a shared object rather than an event stream, and how its type accumulates.
sidebar:
  order: 3
---

The context is **one mutable object, created per `execute()` call**, threaded by
reference through every step of that run. penstock owns five fields on it; your
steps add the rest by returning objects.

```ts
interface BaseContext<TInput> {
  readonly input: TInput; // the original execute() payload
  readonly engines: EngineAccessor; // ctx.engines.<name>.<method>()
  readonly logger: Logger; // this run's logger
  readonly signal: AbortSignal; // pipeline-level cancellation
  readonly executionId: string; // UUID for this execute() call
}
```

Two consequences of "per call" are worth stating plainly. Concurrent runs of the
same pipeline never see each other's data, because each `execute()` builds its
own context. And `input` is pinned as a **non-writable** property, so neither the
library nor a step can overwrite the original payload:

```ts
try {
  (ctx as { input: Order }).input = { id: 'hacked', premium: false };
} catch (err) {
  console.log('writing ctx.input threw:', (err as Error).constructor.name);
}
```

```text
writing ctx.input threw: TypeError
```

## Why a shared object and not an event stream

The obvious alternative is an event-emitter model: each step emits what it
produced, later steps subscribe to what they need. penstock deliberately does not
work that way.

An explicit shared context **keeps data flow legible and decouples steps from
each other's signatures**. You can read a pipeline top to bottom and see what
exists by the time each step runs. In an emitter model, ordering and data
provenance become implicit — the question "where did `reservationId` come from,
and is it there yet?" is answered by tracing subscriptions across the file rather
than by reading down the chain.

The trade-off is real and accepted: **steps can overwrite each other's keys.**
That is mitigated by naming discipline, by the accumulated types below, and by
tests — not by pretending it cannot happen. When a step returns a key that
already exists, it overwrites, exactly as an assignment would:

```ts
pipeline<Order>('demo')
  .step('price', () => ({ total: 100 }))
  .step('discount', (ctx) => ({ total: ctx.total * 0.9 })); // overwrites
```

```text
total: 90
```

## The type accumulates

Each step declares what it produces, and the context **type** grows down the
chain. A field is required from the moment its step has run:

```ts
pipeline<Order>('checkout')
  .step('reserve', async (ctx) => ({ reservationId: await reserve(ctx.input) }))
  .step('charge', async (ctx) => {
    ctx.input; // Order (readonly)
    ctx.reservationId; // string — required, produced above
    return { chargeId: await charge(ctx.reservationId) };
  });
```

Reading a key before the step that produces it is a compile error, not a runtime
`undefined`:

```text
error TS2339: Property 'total' does not exist on type
'TypedCtx<{ id: string; }, { reservationId: string; }>'.
```

That error message is the accumulated state, printed. `TypedCtx<TInput, TState>`
is `BaseContext<TInput> & TState`, and `TState` is everything the chain has
produced so far.

Under the hood a pipeline carries three type parameters: the input, the state
accumulated **before** the most recent step, and that step's **own**
contribution. Splitting the last contribution out is what makes the chained
modifiers work — and what makes the next section possible.

## A guarded step's contribution becomes optional

`.when()` may skip its step. If the accumulated type still claimed that step's
keys were required, every downstream step would be lying to you. So `.when()`
weakens the guarded step's contribution to `Partial`:

```ts
pipeline<Order>('checkout')
  .step('price', () => ({ subtotal: 100 }))
  .step('discount', (ctx) => ({ discount: ctx.subtotal * 0.1 }))
  .when((ctx) => ctx.input.premium)
  .step('total', (ctx) => ({
    // `subtotal` is required; `discount` is `number | undefined`, because the
    // step that produces it is guarded.
    total: ctx.subtotal - (ctx.discount ?? 0),
  }));
```

```text
premium : {"subtotal":100,"discount":10,"total":90}
standard: {"subtotal":100,"total":100}
```

Skip the `?? 0` and the compiler stops you:

```text
error TS2322: Type 'number | undefined' is not assignable to type 'number'.
  Type 'undefined' is not assignable to type 'number'.
```

Note that only the *guarded step's own* keys are weakened. Everything produced
before it stays required, which is precisely why the pipeline tracks the last
contribution separately.

`.undo()` goes the other way. A compensation only ever runs for a step that
**completed**, so inside `undo` that step's output is **required** — no `!` and
no `if (chargeId)`:

```ts
  .step('charge', async (ctx) => ({ chargeId: await charge(ctx.reservationId) }))
  .undo(async (ctx) => refund(ctx.chargeId)) // string, not string | undefined
```

## The parallel write-isolation caveat

This is the one place the shared-object design needs care from you.

**All steps in a parallel group share the same mutable `ctx`.** Steps that write
to **distinct** keys are safe — their contributions are merged as each one
finishes, and a later step sees all of them:

```ts
const forOrder = defineStep<Order>();
const fetchStock = forOrder('fetch-stock', async () => ({ inStock: true }));
const fetchRate = forOrder('fetch-rate', async () => ({ shippingRate: 4.5 }));

pipeline<Order>('demo')
  .parallel([fetchStock, fetchRate])
  .step('report', (ctx) => {
    console.log('inStock:', ctx.inStock, '| shippingRate:', ctx.shippingRate);
  });
```

```text
inStock: true | shippingRate: 4.5
```

Two parallel steps writing the **same** key race, and the winner is whichever
finished last. The types catch conflicting *types* — one step producing
`total: number` and another `total: string` will not compile — but they cannot
catch two steps producing the same key at the same type. **Give every parallel
step its own output field.** If two of them genuinely compute the same thing,
that is a sequential step, not a group.

The isolation that *is* enforced: a step whose own signal has aborted — by
timeout or by cancellation — cannot write. Without that, an abandoned attempt
could resolve long after the pipeline finished and mutate a context nobody is
watching.

## Reserved keys

A contribution may not use a key penstock owns (`input`, `engines`, `logger`,
`signal`, `executionId`), and it may not use `__proto__`, `prototype`, or
`constructor`. Both raise a `UsageError`.

The second group is the prototype-pollution guard. A step's return is user data
reaching a computed property write, which is exactly the shape that invariant
exists for — so the merge validates **every key before writing any** (a
contribution carrying one hostile key never lands its innocent ones) and writes
with `Object.defineProperty` rather than assignment, so nothing consults a setter
up the prototype chain. See the [security model](../../security/).

## `executionId`

`ctx.executionId` is a UUID generated per `execute()` call — the correlation id
shared by that run's logs, traces, and default idempotency keys, and surfaced
again as `result.executionId`. A pipeline run through
[`.compose()`](../../guides/composition/) is a **separate** execution with its own
id, tied to the outer run through `StepReport.innerResult`.

## Next

- [Results and reporting](../results/) — the final context comes back typed.
- [The typed builder](../../guides/typed-builder/) — accumulation in depth.
- [Parallel groups](../../guides/parallel/) — the group semantics behind the caveat.
