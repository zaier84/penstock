---
title: Engines
description: Reusable, named bundles of domain functions that steps call through ctx.engines — and why they sit outside the linear flow.
sidebar:
  order: 4
---

An engine is a named bundle of domain functions, invoked by steps through
`ctx.engines.<name>.<method>()`. Engines are **callable services, not part of the
linear flow**: a step decides *when* something happens, an engine knows *how* to
do it.

```ts
import { Engine, pipeline } from 'penstock';

const pricing = new Engine('pricing', {
  subtotal(order: Order): number {
    return order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  },
  tax(subtotal: number): number {
    return Math.round(subtotal * 0.2);
  },
});

const p = pipeline<Order>('price-order')
  .useEngine(pricing)
  .step('subtotal', (ctx) => ({
    subtotal: ctx.engines.pricing.subtotal(ctx.input) as number,
  }))
  .step('tax', (ctx) => ({
    tax: ctx.engines.pricing.tax(ctx.subtotal) as number,
  }));

const result = await p.execute({ items: [{ price: 1000, qty: 2 }] });
console.log('subtotal:', result.context.subtotal, '| tax:', result.context.tax);
```

```text
subtotal: 2000 | tax: 400
```

The point is separation. Without engines, domain logic ends up inlined in step
bodies, where it is hard to reuse across pipelines and hard to test without
running a pipeline. With them, the pipeline reads as orchestration and the
arithmetic lives somewhere you can unit-test directly.

## Scope them to the pipeline

`.useEngine(engine)` registers an engine for one pipeline. That is the
recommended approach, and it has two properties process-wide registration does
not: **it needs no teardown in tests**, and **two pipelines can use different
engines under the same name** — which is exactly what stubbing looks like.

```ts
const stub = new Engine('pricing', { quote: () => 999 });
const result = await buildCheckout(stub).execute(order);
```

See [Testing your pipelines](../../guides/testing/) for the full pattern.

A process-wide `registerEngine` / `clearEngines` registry also exists and still
works, but it is **deprecated as of 0.5.0**. It is shared mutable state that
leaks between test suites unless every one of them remembers `clearEngines()`.
[Migrating from the class API](../../migrating/) covers the swap.

## An unknown name throws

`ctx.engines` is a proxy over a null-prototype object, and lookups go through a
`Map`. Reading a name that was never registered raises a `UsageError` rather than
yielding `undefined` and a `TypeError` three lines later:

```text
Unknown engine "shipping". Register it on the pipeline with useEngine(engine)
before a step reads ctx.engines.
```

Because a name never walks a prototype chain, `ctx.engines.constructor` is simply
an unknown engine — not a function you did not mean to call. That is the same
prototype-pollution guard described in the [security model](../../security/).

The error surfaces as an ordinary step failure: `result.ok` is `false`,
`result.error` is a `StepError`, and its `.cause` is the `UsageError`.

## Method return types

Engine methods are typed as returning `unknown`, so you cast at the call site:

```ts
subtotal: ctx.engines.pricing.subtotal(ctx.input) as number,
```

That is the price of a name-keyed accessor whose contents are registered at run
time. If the cast bothers you, call the engine's methods directly — an `Engine`
holds no state, so `pricing.methods.subtotal(order)` and a plain imported
function are both fine. `ctx.engines` exists so a step can reach a dependency it
did not import, which is what makes stubbing possible.

## Construction rules

`new Engine(name, methods)` validates eagerly, throwing `UsageError` for a name
that is empty, non-string, or reserved (`__proto__`, `prototype`, `constructor`);
for a `methods` value that is not an object; for an empty bundle; and for any
property whose value is not a function. An engine instance is immutable — `name`
and `methods` are `readonly`.

A method is called as `ctx.engines.pricing.total(...)`, so it runs with the
bundle as its `this`. Pure functions are recommended.

## Next

- [Steps](../steps/) — where engines get called from.
- [Testing your pipelines](../../guides/testing/) — stubbing engines.
- [Migrating from the class API](../../migrating/) — replacing the global registry.
