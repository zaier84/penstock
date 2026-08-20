---
title: Migrating from the class API
description: The typed builder equivalent of every class-API construct, plus the 0.5.0 deprecations and what replaces them.
---

Nothing here is required. Code written against `Pipeline` and `Step` compiles
and behaves identically on `0.5.0`, and the class API is **fully supported, not
legacy**. The typed builder is a facade over it: `.step(...)` constructs a
`Step`, the chain constructs a `Pipeline`, and execution, rollback, retry,
timeout, cancellation, tracing, and lifecycle events are all the same code
either way.

If you do move, the mapping is mechanical.

## The same pipeline, both ways

```ts
// ── class API ───────────────────────────────────────────────────────────────
interface OrderCtx extends BaseContext<Order> {
  reservationId?: string;
  chargeId?: string;
}

const classApi = new Pipeline<OrderCtx>('checkout')
  .addStep(
    new Step<OrderCtx>('reserve', {
      run: async (ctx) => {
        ctx.reservationId = await reserve(ctx.input.items);
      },
      undo: async (ctx) => release(ctx.reservationId!), // note the `!`
      retry: { attempts: 3, backoff: 'exponential' },
    }),
  )
  .addStep(
    new Step<OrderCtx>('charge', async (ctx) => {
      ctx.chargeId = await charge(ctx.input.card, ctx.reservationId!);
    }),
  );

// ── typed builder ───────────────────────────────────────────────────────────
const builder = pipeline<Order>('checkout')
  .step('reserve', async (ctx) => ({
    reservationId: await reserve(ctx.input.items),
  }))
  .undo(async (ctx) => release(ctx.reservationId)) // no `!`
  .retry({ attempts: 3, backoff: 'exponential' })
  .step('charge', async (ctx) => ({
    chargeId: await charge(ctx.input.card, ctx.reservationId),
  }));
```

Run both against the same input and compare the `Result`:

```text
class API    : {"ok":true,"steps":["reserve:completed:1","charge:completed:1"],"reservationId":"rsv_2","chargeId":"chg_tok_visa_rsv_2"}
typed builder: {"ok":true,"steps":["reserve:completed:1","charge:completed:1"],"reservationId":"rsv_2","chargeId":"chg_tok_visa_rsv_2"}
identical: true
```

## The three moves

**Delete the context interface.** It is derived from what the steps return. A
mid-run field is required from the moment its step has run, rather than optional
forever.

**Return what you used to assign.** `ctx.reservationId = x` becomes
`return { reservationId: x }`. The return is merged onto the context through a
single path that also refuses reserved keys.

**Move step options into chained calls.** `when`, `undo`, `retry`, `timeout`,
and `idempotencyKey` leave the options object and become modifiers *after* the
step. That ordering is not cosmetic: typing `undo` from inside the same object
literal would require inferring a run's return type in order to type a sibling
property of that same literal, which is circular. Chaining is what makes
`ctx.reservationId` required inside `undo`.

## Construct by construct

| Class API | Typed builder |
| --- | --- |
| `new Pipeline<Ctx>(name)` | `pipeline<TInput>(name)` |
| `.addStep(new Step(name, run))` | `.step(name, run)` |
| `new Step(name, { run, when })` | `.step(name, run).when(fn)` |
| `new Step(name, { run, undo })` | `.step(name, run).undo(fn)` |
| `new Step(name, { run, retry })` | `.step(name, run).retry(options)` |
| `new Step(name, { run, timeout })` | `.step(name, run).timeout(ms)` |
| `new Step(name, { run, idempotencyKey })` | `.step(name, run).idempotencyKey(key)` |
| A `Step` reused across pipelines | `defineStep<TInput>()(name, run)` + `.use(def)` |
| `.addParallel([a, b], options)` | `.parallel([defA, defB], options)` over `defineStep` definitions |
| `.asStep(name, { mapInput, mapResult })` | `.compose(name, inner, { mapInput, mapResult })` |
| `.before` / `.after` / `.onError` | identical |
| `.onComplete` / `.onFailure` / `.onCancel` / `.onSettled` | identical |
| `.useEngine(engine)` | identical |
| `.execute(input, options)` | identical |
| — | `.toPipeline()` returns the `Pipeline` underneath |

Two of those differ in more than spelling.

**[`.parallel()`](../guides/parallel/) takes an array of [`defineStep`](../guides/define-step/) definitions**, not `Step`
instances, and their contributions are intersected into the accumulated type so
a later step sees all of them at once. It is an array rather than an object on
purpose: declaration order decides rollback order and which failure becomes
`result.error`, and JavaScript reorders integer-like keys in objects, so an
object form would silently reorder a group containing a step named `"1"`.

**[`.compose()`](../guides/composition/)'s `mapResult` returns a contribution** instead of writing onto
the outer context by hand. That is what lets the accumulated type follow it.
Omitting `mapResult` runs the inner pipeline purely for its effects.

## When to stay on the class API

- **Building a pipeline from a dynamic list** — a loop of `addStep` calls whose
  steps are not known at compile time and so cannot be typed by accumulation
  anyway.
- **Sharing one `Step` instance across pipelines**, or deriving variants with
  `step.when(...)`. `defineStep` covers most of this with types intact.
- **Declaring the context type yourself**, when it is already defined elsewhere
  in your codebase.

You give up accumulation: mid-run fields stay optional on your context
interface, and downstream steps use `ctx.total!` once an earlier step has set
them. That assertion is the idiom there, and removing it is the reason the
builder exists.

`.toPipeline()` hands you the `Pipeline` a builder describes, fully configured,
so the two can be mixed:

```ts
const built = pipeline<Order>('checkout')
  .step('validate', validateOrder)
  .toPipeline();

built.addStep(extraStep); // carry on with the class API from here
```

## Deprecated in 0.5.0

Both still work exactly as before and will keep working until `1.0`. Neither
emits a runtime warning — console noise from a library is disproportionately
annoying in test suites, and it does not make anyone migrate faster.

### `UseCase`

A thin composition that runs one or more pipelines **sequentially on the same
input**, aggregating their results and short-circuiting on the first failure.
Each pipeline builds its own fresh context, which is precisely the limitation:
nothing one pipeline produces can reach the next.

```ts
import { UseCase } from 'penstock';

const checkout = new UseCase('checkout')
  .addPipeline(orderPipeline)
  .addPipeline(fulfillmentPipeline);

const result = await checkout.execute(input); // { ok, pipelines, error }
```

**Use `.compose(...)` — or `pipeline.asStep(...)` on the class API — instead.**
Both nest one pipeline inside another *and* let data flow between them through
`mapInput` / `mapResult`, which is the thing a `UseCase` cannot do.

### `registerEngine` and `clearEngines`

The process-wide engine registry. `registerEngine(engine)` adds to it,
`clearEngines()` empties it, and `ctx.engines.<name>` falls back to it when no
pipeline-scoped engine matches.

```ts
import { clearEngines, registerEngine } from 'penstock';

registerEngine(pricing); // process-wide
afterEach(clearEngines); // ...and every test suite must remember this
```

**Use `.useEngine(engine)` instead.** It is not process-wide mutable state, so
it needs no teardown in tests, and two pipelines can use different engines under
the same name — neither of which the global registry allows.
