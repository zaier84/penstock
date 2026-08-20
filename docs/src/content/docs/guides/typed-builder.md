---
title: Typed builder and context accumulation
description: How each step's return grows the context type, what the three type parameters do, and the compile errors that result.
sidebar:
  order: 1
---

The typed builder is the primary API. Its job is to remove one specific piece of
friction: the `ctx.total!` that a shared context interface forces on every
downstream step.

## The rule, in one line

**A step's return becomes the next state.** Everything else follows from that.

```ts
pipeline<Order>('checkout')
  .step('reserve', async (ctx) => ({ reservationId: await reserve(ctx.input) }))
  .step('charge', async (ctx) => {
    ctx.reservationId; // string — required, produced above
    return { chargeId: await charge(ctx.reservationId) };
  })
  .step('ship', async (ctx) => {
    ctx.chargeId; // string
  });
```

Returning nothing contributes nothing. Returning a key that already exists
overwrites it, and the type overwrites with it:

```ts
  .step('total', (ctx) => ({ total: ctx.subtotal - (ctx.discount ?? 0) }))
  .step('round', (ctx) => ({ total: Math.round(ctx.total) })) // still a number
```

## Reading a key too early does not compile

```ts
pipeline<{ id: string }>('checkout')
  .step('reserve', () => ({ reservationId: 'rsv_1' }))
  .step('charge', (ctx) => {
    console.log(ctx.total);
  });
```

```text
error TS2339: Property 'total' does not exist on type
'TypedCtx<{ id: string; }, { reservationId: string; }>'.
```

The error message *is* the accumulated state. `TypedCtx<TInput, TState>` is
`BaseContext<TInput> & TState`, and the second parameter lists everything
produced so far.

## Guards weaken the contribution

A `.when()`-guarded step may not run, so its keys become optional downstream —
and only its own keys:

```ts
const checkout = pipeline<Order>('checkout')
  .step('price', () => ({ subtotal: 100 }))
  .step('discount', (ctx) => ({ discount: ctx.subtotal * 0.1 }))
  .when((ctx) => ctx.input.premium)
  .step('total', (ctx) => ({
    total: ctx.subtotal - (ctx.discount ?? 0),
  }))
  .step('round', (ctx) => ({ total: Math.round(ctx.total) }));
```

```text
premium : {"subtotal":100,"discount":10,"total":90}
standard: {"subtotal":100,"total":100}
```

Drop the `?? 0`:

```text
error TS2322: Type 'number | undefined' is not assignable to type 'number'.
  Type 'undefined' is not assignable to type 'number'.
```

`.undo()` is the mirror image: a compensation only runs for a step that
completed, so it sees that step's output as **required**.

## The three type parameters

`TypedPipeline<TInput, TPrev, TLast>` carries the input type, the state
accumulated **before** the most recent step, and that step's **own**
contribution. The current full state is `Merge<TPrev, TLast>`.

Keeping the last contribution separate is what makes the modifiers work.
`.when()` weakens `TLast` to `Partial<TLast>` because it knows exactly which keys
the guarded step contributed. `.undo()` offers `Merge<TPrev, TLast>` with those
keys required. Neither would be expressible if the state were a single flat blob.

It also explains why modifiers chain **after** the step. Typing `undo` inside an
options object next to `run` would mean inferring the run's return type in order
to type a sibling property of the same object literal — a circular constraint TypeScript
cannot resolve.

## Named return types work

A step's return is constrained to `object`, not `Record<string, unknown>`, so an
interface-typed return is fine:

```ts
interface Reservation {
  reservationId: string;
  warehouse: string;
}

pipeline<Order>('p').step(
  'reserve',
  async (ctx): Promise<Reservation> => reserve(ctx.input.items),
);
```

An `interface` has no implicit index signature, so it is *not* assignable to
`Record<string, unknown>` and would fail to compile against that constraint.
`object` accepts it while still excluding primitives.

## What observers see

`before`, `after`, and `onError` are typed with a `Partial` of the accumulated
state. That is type-honest, not pessimistic: they fire for *every* step, so at
any given firing only the keys produced so far exist. Lifecycle callbacks
(`onComplete` and friends) fire once at the end and see the full state.

## Strict mode is not optional

The accumulated types compute without `strict`, but the compiler will not hold
you to them — `strictNullChecks` in particular is what makes
`number | undefined` an error rather than a shrug. See
[Installation](../../getting-started/installation/).

## What the builder does not change

It is a facade over `Step` and `Pipeline`: `.step(...)` constructs a `Step`, the
chain constructs a `Pipeline`, and execution, rollback, retry, timeout,
cancellation, tracing, and lifecycle events are the same code either way.
`.toPipeline()` reaches the pipeline underneath. Nothing about the runtime
behaviour is type-driven.

## Next

- [Reusable steps with `defineStep`](../define-step/) — accumulation across files.
- [Context and typed state](../../concepts/context/) — the design behind it.
- [Migrating from the class API](../../migrating/) — if you have `ctx.total!` today.
