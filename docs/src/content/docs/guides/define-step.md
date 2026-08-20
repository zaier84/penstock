---
title: Reusable steps with defineStep
description: Declare a step once, use it in many pipelines, and let it declare the prior state it requires.
sidebar:
  order: 2
---

A step declared inline belongs to its pipeline. `defineStep` declares one
**independently** — named, typed, and reusable across pipelines.

```ts
import { defineStep, pipeline } from 'penstock';

const forOrder = defineStep<Order>();

const authenticate = forOrder('authenticate', async () => ({
  token: await login(),
}));

pipeline<Order>('sync').use(authenticate);
```

## Why the call has two stages

`defineStep<Order>()(name, run)` looks odd until you try to write it as one call.
TypeScript has **no partial type-argument inference**: supplying `TInput`
explicitly would force you to supply the run function's type too, which defeats
inference of what the step produces.

So the first call fixes the input type (and any required prior state), and the
second infers the run. Binding the first stage to a name, as `forOrder` above,
makes the repetition disappear.

## Declaring what a step requires

The second type parameter is the prior state the step needs. Using it before
that state exists is a **compile error**, not a runtime `undefined`:

```ts
const callApi = defineStep<{ id: string }, { token: string }>()(
  'call-api',
  async (ctx) => ({ profile: `profile-for-${ctx.token}` }),
);

pipeline<{ id: string }>('sync').use(callApi);
```

```text
error TS2345: Argument of type 'StepDef<{ id: string; }, { token: string; },
{ profile: string; }>' is not assignable to parameter of type 'never'.
```

The parameter resolves to `never` when the accumulated state does not satisfy the
requirement, which is what produces that message. Produce `token` first and it
compiles:

```ts
pipeline<{ id: string }>('sync')
  .use(authenticate) // produces { token: string }
  .use(callApi) // ✓
  .step('done', (ctx) => {
    console.log('profile:', ctx.profile);
  });
```

```text
profile: profile-for-tok_1
ok: true
```

`use` is otherwise exactly `step`: the definition's contribution becomes the new
last contribution, as if it had been declared inline.

## Definitions are immutable

`.when()`, `.undo()`, `.retry()`, `.timeout()`, and `.idempotencyKey()` each
return a **new** definition. The original is untouched, so one definition can be
shared across pipelines and specialised per use:

```ts
const flakyCallApi = callApi.retry({ attempts: 3, delayMs: 10 });
```

```text
derived a new definition: true
same name: call-api call-api
```

Both definitions keep the same step name, so they cannot appear in the same
pipeline — step names are unique per pipeline, and the duplicate throws a
`UsageError` at the `.use()` call.

The modifiers carry the same typing rules as the builder's: `.when()` weakens the
definition's contribution to `Partial`, and `.undo()` sees its own output as
required.

## Parallel groups take definitions

`.parallel()` takes an **array of definitions**, not inline steps — which is the
main reason `defineStep` exists:

```ts
const forOrder = defineStep<Order>();
const fetchStock = forOrder('fetch-stock', async (ctx) => ({
  stock: await inventory.check(ctx.input.items),
}));
const checkFraud = forOrder('check-fraud', async () => ({ fraudScore: 0.02 }));

pipeline<Order>('checkout')
  .parallel([fetchStock, checkFraud])
  .step('charge', (ctx) => {
    ctx.stock;
    ctx.fraudScore; // both present
  });
```

See [Parallel groups and concurrency](../parallel/).

## Testing a definition on its own

A definition is a value, so a test can exercise it in a one-step pipeline without
the rest of the flow:

```ts
const result = await pipeline<Order>('t').use(validate).execute(order);
expect(result.steps[0]?.error?.cause).toMatchObject({ message: 'empty order' });
```

[Testing your pipelines](../testing/) has the rest.

## What a definition holds

`StepDef<TInput, TRequires, TProduces>` exposes `name` and the constructed
`step`. The three type parameters are carried by a phantom brand that exists only
in the type system — `RequiresOf<T>` and `ProducesOf<T>` recover them if you need
to write a helper over definitions. The name is validated at definition time,
because the `Step` is built there.

## Next

- [Parallel groups and concurrency](../parallel/) — where definitions are required.
- [Typed builder and context accumulation](../typed-builder/) — the typing rules.
- [Steps](../../concepts/steps/) — the unit itself.
