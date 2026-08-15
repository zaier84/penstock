# penstock

> Composable, testable backend workflows for Node.js — use-cases, pipelines, steps, and engines, with first-class reverse-order rollback.

[![npm version](https://img.shields.io/npm/v/penstock.svg)](https://www.npmjs.com/package/penstock)
[![CI](https://github.com/zaier84/penstock/actions/workflows/ci.yml/badge.svg)](https://github.com/zaier84/penstock/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/penstock.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/penstock?activeTab=dependencies)
[![provenance](https://img.shields.io/badge/provenance-enabled-blue.svg)](https://docs.npmjs.com/generating-provenance-statements)

penstock turns sprawling sequential backend logic into a series of **named, testable, composable
steps**. A pipeline threads one typed context through its steps in order, evaluating guards, firing
observer hooks, and — when a step fails — **walking backwards to undo the work that already
happened**. Failure is returned as data: a structured `Result` tells you which steps ran, were
skipped, failed, or rolled back, with timings and the causal error. It has **zero runtime
dependencies** and a deliberately small, prototype-pollution-safe surface.

## Install

```sh
npm install penstock
```

penstock ships dual **ESM + CommonJS** builds with bundled TypeScript types. Node `>=20` (Node 22+
recommended).

> Zero runtime dependencies. The optional `penstock/otel` adapter requires `@opentelemetry/api`,
> which you install only if you use it.

## Quick start

```ts
import { Engine, Pipeline, Step } from 'penstock';
import type { BaseContext } from 'penstock';

interface LineItem {
  sku: string;
  price: number;
  qty: number;
}

interface OrderInput {
  items: LineItem[];
  customer: { id: string; tier: 'standard' | 'premium' };
}

// Mid-run fields are optional: they don't exist until the step that sets them.
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string;
  subtotal?: number;
  total?: number;
}

// An engine is a reusable bundle of domain functions, called by steps.
const pricingEngine = new Engine('pricing', {
  subtotal(order: OrderInput): number {
    return order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  },
});

const orderPipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(
    new Step<OrderCtx>('validate-order', (ctx) => {
      if (ctx.input.items.length === 0) throw new Error('Order has no items');
    }),
  )
  .addStep(
    new Step<OrderCtx>('reserve-inventory', {
      run: (ctx) => {
        ctx.reservationId = `rsv_${ctx.input.customer.id}`;
      },
      undo: (ctx) => {
        console.log(`released inventory ${ctx.reservationId}`);
      },
    }),
  )
  .addStep(
    new Step<OrderCtx>('calculate-total', (ctx) => {
      // Engine methods are typed as returning `unknown`; cast at the call site.
      ctx.subtotal = ctx.engines.pricing.subtotal(ctx.input) as number;
      ctx.total = ctx.subtotal;
    }),
  )
  .addStep(
    new Step<OrderCtx>('apply-premium-discount', {
      run: (ctx) => {
        ctx.total = Math.round((ctx.total ?? 0) * 0.9 * 100) / 100;
      },
      when: (ctx) => ctx.input.customer.tier === 'premium',
    }),
  )
  .useEngine(pricingEngine);

const result = await orderPipeline.execute({
  items: [
    { sku: 'A-1', price: 1000, qty: 2 },
    { sku: 'B-2', price: 500, qty: 1 },
  ],
  customer: { id: 'cust_42', tier: 'premium' },
});

console.log('ok:', result.ok, '| total:', result.context.total);
console.log(
  'steps:',
  result.steps.map((s) => `${s.name}:${s.status}`).join(', '),
);
```

```text
ok: true | total: 2250
steps: validate-order:completed, reserve-inventory:completed, calculate-total:completed, apply-premium-discount:completed
```

A full, runnable version of this flow (including a forced-failure rollback) lives in
[`examples/order-processing.ts`](./examples/order-processing.ts) — run it with `npm run example:order`.

## Core concepts

### Step

The atomic unit of work: a named `run` function that receives the shared context and may mutate it.
A step can declare a `when` guard (a pure predicate that skips it) and an `undo` (compensation run
during rollback). Steps are immutable and reusable — `.when(...)` returns a configured **clone**
rather than mutating the original.

```ts
const reserve = new Step<OrderCtx>('reserve-inventory', {
  run: async (ctx) => {
    ctx.reservationId = await reserve(ctx.input.items);
  },
  undo: async (ctx) => {
    await release(ctx.reservationId!);
  },
});

const premiumOnly = reserve.when(
  (ctx) => ctx.input.customer.tier === 'premium',
);
```

### Pipeline

An ordered, named collection of steps. It threads one context through them, evaluates guards, fires
hooks, and owns error handling and the rollback chain. `execute` builds a **fresh context per call**
and resolves with a `Result`.

```ts
const pipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validateOrder)
  .addStep(reserveInventory)
  .before((ctx, step) => {
    /* observe */
  })
  .after((ctx, step, report) => {
    /* report = { status, durationMs } */
  })
  .onError((err, ctx, step) => {
    /* observe a failure, before rollback */
  });
```

### Engine

A reusable, named bundle of domain functions, invoked by steps via `ctx.engines.<name>`. Engines are
callable services, not part of the linear flow — they keep domain logic out of step wiring. Register
one globally with `registerEngine`, or scope it to a single pipeline with `useEngine` (the
recommended, no-globals approach; a scoped engine shadows a global one of the same name). Accessing an
unregistered name throws a clear `UsageError`, never `undefined`.

```ts
import { Engine, registerEngine } from 'penstock';

const pricing = new Engine('pricing', {
  total(order: OrderInput) {
    return order.items.reduce((s, i) => s + i.price * i.qty, 0);
  },
});

registerEngine(pricing); // process-wide; or: pipeline.useEngine(pricing)
```

### Context

The context is one mutable object created per `execute` call and threaded by reference through every
step. The library owns `BaseContext` (`input`, `engines`, `logger`, `signal`, `executionId`); you
extend it with your own working fields. Explicit shared context keeps data flow legible and decouples
steps from each other's signatures; the tradeoff (steps can overwrite each other's keys) is mitigated
by naming discipline, types, and tests.

```ts
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string; // populated by reserve-inventory
  total?: number; // populated by calculate-total
}
```

`ctx.executionId` is a UUID generated per `execute` call — the correlation id shared by that run's
logs, traces, and default idempotency keys, and surfaced again as `result.executionId`. A pipeline
run through `asStep` is a **separate** execution with its own id, tied to the outer run through
`StepReport.innerResult`.

### UseCase

A thin composition that runs one or more pipelines **sequentially on the same input**, aggregating
their results and short-circuiting on the first failure. Each pipeline builds its own fresh context —
pipelines do not share mutable state.

```ts
import { UseCase } from 'penstock';

const checkout = new UseCase('checkout')
  .addPipeline(orderPipeline)
  .addPipeline(fulfillmentPipeline);

const result = await checkout.execute(input); // { ok, pipelines, error }
```

## Rollback & compensation

This is penstock's standout feature. When a step's `run` throws, the pipeline **aborts the flow and
walks backwards** through the steps that already completed, running each one's `undo` (if it declared
one). Compensations are best-effort and independent: a failing `undo` does not abort the remaining
ones — it is recorded instead, so a broken compensation can never strand the resources the others
would release.

- Completed steps **with** an `undo` are compensated in reverse order → status `'rolled-back'`
  (or `'rollback-failed'`, with the error pushed to `result.rollbackErrors`, if the `undo` throws).
- Completed steps **without** an `undo` declare themselves to need none and stay `'completed'`.
- The step whose `run` failed is `'failed'` and is not itself compensated.
- `onError` hooks fire once, for the originating failure, **before** rollback begins.

```ts
// Same pipeline as the quick start, with a step that fails at shipping.
const failed = await orderPipeline.execute({
  items: [{ sku: 'A-1', price: 1000, qty: 2 }],
  customer: { id: 'cust_42', tier: 'premium' },
  failOnShip: true,
});

console.log('ok:', failed.ok);
console.log('error:', failed.error?.message);
console.log(
  'steps:',
  failed.steps.map((s) => `${s.name}:${s.status}`).join(', '),
);
console.log('rollbackErrors:', failed.rollbackErrors);
```

```text
released inventory rsv_cust_42
ok: false
error: Step "ship-order" failed
steps: validate-order:completed, reserve-inventory:rolled-back, calculate-total:completed, apply-premium-discount:completed, ship-order:failed
rollbackErrors: []
```

`reserve-inventory` rolled back (its `undo` released the reservation), the steps without an `undo`
stayed `completed`, and `ship-order` is `failed`. `result.error` is a `StepError` whose `.cause` is
the original thrown error. If you prefer `try/catch`, pass `{ throwOnError: true }` and a
`PipelineError` is thrown instead, carrying the full `.result`, the originating `.cause`, and — when
any `undo` failed — a native `AggregateError` on `.rollbackErrors`.

## Reliability

penstock adds four opt-in reliability controls: per-step **retry**, per-step **timeout**,
**idempotency keys**, and pipeline-level **cancellation**. They compose — a single step can carry
retry, a timeout and a key at once, and any pipeline can be cancelled mid-flight — and they never
change behaviour unless you ask for them.

### Step metadata

Every `run` and `undo` receives a second argument, `meta: StepMeta`, describing **this invocation** —
which the shared context cannot, since one context is threaded through the whole run and shared by
the concurrent steps of a parallel group.

```ts
new Step<OrderCtx>('charge-payment', {
  run: async (ctx, meta) => {
    meta.stepName; // 'charge-payment'
    meta.pipelineName; // 'process-order'
    meta.executionId; // UUID for this execute() call
    meta.attempt; // 1-based attempt number
    meta.maxAttempts; // total tries allowed (1 when no retry)
    meta.idempotencyKey; // stable across every attempt
    meta.signal; // this invocation's own AbortSignal

    await gateway.charge(ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey,
      signal: meta.signal,
    });
  },
});
```

Declaring fewer parameters stays valid — a one-argument `run` is unaffected. Guards deliberately
receive **no** metadata: they are contractually pure predicates that dry-run relies on evaluating
safely, and an attempt number would invite side-effectful guards.

### Retry

Give a step a `retry` policy and its `run` is re-invoked on failure. `attempts` is the **total**
number of tries including the first, so `attempts: 3` means one try plus up to two retries. Delays
between attempts are `'fixed'` (default) or `'exponential'`, with optional `jitter`. Only `run` is
retried — a `when` guard and an `undo` are never retried.

```ts
const fetchInventory = new Step<OrderCtx>('fetch-inventory', {
  run: async (ctx) => {
    ctx.inventoryToken = await inventory.reserve(ctx.input.items);
  },
  retry: { attempts: 3, delayMs: 500, backoff: 'exponential' },
});
```

The resulting `StepReport.attempts` records how many times `run` was actually called — a step that
succeeded on its third try reports `attempts: 3`.

### Timeout

`timeout` bounds a single attempt in milliseconds. When it elapses, the attempt rejects with a
`TimeoutError`, the step is marked `'failed'`, and `StepReport.timedOut` is `true`. It applies **per
attempt**, so it composes with `retry` — each try gets the full timeout.

```ts
const charge = new Step<OrderCtx>('charge-payment', {
  run: (ctx) => payments.charge(ctx.input.amount),
  timeout: 5000, // each attempt gets 5s
});
```

### Idempotency keys

A retried step calls the same external service twice. `idempotencyKey` gives that service a stable
token so it can recognise the second call as the same operation — the difference between a retry and
a double charge. The key is resolved **once per step invocation, before the first attempt**, and
reused unchanged for every retry; re-deriving it per attempt would defeat the entire purpose.

```ts
const charge = new Step<OrderCtx>('charge-payment', {
  run: async (ctx, meta) => {
    await gateway.charge(ctx.input.amount, {
      idempotencyKey: meta.idempotencyKey, // identical on attempts 1, 2 and 3
    });
  },
  retry: { attempts: 3 },
  // Derived from the order, so re-running the whole pipeline for this order
  // presents the gateway with the same key again.
  idempotencyKey: (ctx) => `charge:${ctx.input.orderId}:${ctx.input.amount}`,
});
```

Every step has a key whether or not you configure one. The default is
`` `${executionId}:${stepName}` ``, unique per execution and per step — safe for retries within a
run, but deliberately **not** stable across runs. Supply a string or a `(ctx) => string` function to
derive one from business data instead, which is what makes a key survive a re-run of the same order.

The key a step actually ran under is recorded on `StepReport.idempotencyKey`, so retry-safety is
auditable straight from the `Result`. A compensation gets the run key plus `:undo`, so an `undo` and
the `run` it reverses are never confused for the same operation.

> A key you derive yourself also appears in traces (`penstock.step.idempotency_key`). Deriving one
> from sensitive data therefore puts that data in your tracing backend — derive from identifiers,
> not from card numbers or personal details.

### Cancellation

Pass an `AbortSignal` to `execute` and the pipeline stops when it aborts. The signal is checked
**between steps** — a step that is already running is never interrupted mid-flight; the _next_
between-step check stops the pipeline. On cancellation, completed steps are **rolled back** exactly
like a failure (reverse order, best-effort) and the abort reason is surfaced as `result.error`, with
`result.aborted === true`.

```ts
const controller = new AbortController();
const result = await orderPipeline.execute(order, {
  signal: controller.signal,
});
// ...elsewhere: controller.abort(new Error('customer cancelled'));
```

Inside a step there are **two** signals, and the distinction matters:

- **`meta.signal`** — this invocation's own signal, created fresh per attempt. It combines the
  step's per-attempt `timeout`, its parallel group's abort (if it is in one), and the pipeline
  signal. This is the one to forward into your own async work.
- **`ctx.signal`** — the **pipeline-level** signal, and only that. It answers "was the whole run
  cancelled". A step's timeout does not abort it.

```ts
new Step<OrderCtx>('reindex', async (ctx, meta) => {
  for (const batch of batches) {
    if (meta.signal.aborted) return; // cancellation, timeout, or peer failure
    await indexer.write(batch, { signal: meta.signal });
  }
});
```

#### Migrating from 0.3.x

**`ctx.signal` no longer aborts when a step's own `timeout` fires — use `meta.signal` instead.**
If a step forwarded `ctx.signal` into its async work to honour its timeout, change it to
`meta.signal`; `ctx.signal` keeps working for "was the pipeline cancelled". Everything else is
additive.

One shared `ctx.signal` could never be the per-attempt timeout signal of several concurrently
running steps at once, so in 0.3.x a step inside a parallel group had no way to observe its own
timeout. `meta.signal` is per invocation, which fixes that.

A full, runnable example combining retry, timeout and cancellation lives in
[`examples/reliability.ts`](./examples/reliability.ts) — run it with `npm run example:reliability`.

## Parallel step groups

`addParallel([...])` runs independent steps **concurrently**. A group occupies a single logical
position in the pipeline: everything before it has finished, all of its steps start together, and
the next entry runs only once every one of them has settled. Guards are still evaluated
sequentially, in declaration order, before anything launches — and `result.steps[]` always lists
the group in declaration order, regardless of completion order, so the `Result` stays
deterministic.

```ts
const pipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validateOrder)
  .addParallel([fetchInventory, checkFraud, fetchPricing]) // concurrent
  .addStep(chargePayment);
```

When any parallel step fails (after its retries), the group **cancels its peers**: in-flight steps
that observe `meta.signal` can stop early, every step is awaited to settlement
(`Promise.allSettled`, never fail-fast), and then the saga unwinds — the group's completed steps
are rolled back in **reverse declaration order**, followed by the prior pipeline steps as usual. A
peer stopped by the group abort reports `'skipped'` with
`skipReason: 'cancelled (parallel peer failed)'`, and `result.error` is the **first** failure in
declaration order (every failure keeps its own `StepReport.error`). Retry, timeout, guards, undo,
and hooks all work inside a group exactly as they do sequentially.

**Context keys are your responsibility.** All parallel steps share the same mutable `ctx`. Steps
that write to **distinct** keys are safe; two parallel steps writing the **same** key race. Give
each parallel step its own output field.

### Concurrency limits

A fan-out of fifty steps opening fifty connections at once is rarely what you want. Pass
`{ concurrency: n }` and at most `n` of the group's steps run at a time, the rest waiting in a
bounded pool that dispatches **in declaration order** as slots free.

```ts
const pipeline = new Pipeline<OrderCtx>('process-order').addParallel(
  [fetchInventory, checkFraud, fetchPricing, fetchShippingRates],
  { concurrency: 2 }, // two in flight; the other two queue
);
```

The limit must be an integer `>= 1`, validated when you build the pipeline — a bad value throws
`UsageError` immediately, not at run time. Omitting it, or setting it at or above the group size,
runs everything at once, exactly as before.

Nothing else about a group changes. Guards are still evaluated sequentially up front, and a
guard-skipped step never occupies a slot. When a step fails, the group aborts as usual — and a step
still **queued** at that moment is simply never dispatched: its `run` is not called at all. It
reports `'skipped'` with `skipReason: 'cancelled (parallel peer failed)'`, exactly like an in-flight
peer that was cancelled.

## Pipeline composition

`pipeline.asStep(name, options)` wraps a whole pipeline as a **single step** of an outer pipeline,
so workflows compose hierarchically. The inner pipeline runs on its **own fresh, isolated
context**: `mapInput` derives its input from the outer context (the only way in), and `mapResult`
— called only on inner success — writes its outputs back (the way out). The outer run's logger and
cancellation signal are forwarded; engines are **not** — the inner pipeline resolves its own
`useEngine` registrations plus the global registry, never the outer pipeline's scoped engines.

```ts
const inventoryCheck = new Pipeline<InvCtx>('check-inventory')
  .addStep(lookupWarehouse)
  .addStep(reserveStock);

const orderPipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validateOrder)
  .addStep(
    inventoryCheck.asStep('run-inventory', {
      mapInput: (ctx) => ({ items: ctx.input.items }),
      mapResult: (innerResult, ctx) => {
        ctx.reservationId = innerResult.context.reservationId;
      },
      undo: async (ctx) => {
        await releaseStock(ctx.reservationId!);
      },
    }),
  )
  .addStep(chargePayment);
```

The two rollback chains stay clearly delineated:

- **The inner pipeline fails** → it rolls back its own completed steps internally, and the wrapping
  step reports `'failed'` (its `error` chains to the inner failure). The outer pipeline then rolls
  back its own prior steps — inner undos are never re-run.
- **The inner pipeline succeeds, a later outer step fails** → the inner work is committed. The
  outer rollback runs the `undo` you gave `asStep` — reversing the inner pipeline's net effect is
  that function's job, because only you know what "undo an entire pipeline" means. Without an
  `undo`, the wrapping step stays `'completed'`.
- **The outer run is cancelled mid-inner-execution** → the signal propagates in; the inner pipeline
  stops between its steps and rolls back; the wrapping step reports `'skipped'` / `'cancelled'`.

Either way, the wrapping step's report carries the full inner `Result` as
`StepReport.innerResult`, so the nested execution stays inspectable without `mapResult`. The
returned value is a regular `Step` — guard it with `when`, clone it with `.when()`, or place it
inside `addParallel([...])` to run whole pipelines concurrently.

## Lifecycle events

Four pipeline-scoped callbacks observe a run once it has fully settled — after execution **and any
rollback**. All are chainable, all can be registered multiple times (they run in registration
order), and all receive the final `Result`:

```ts
const pipeline = new Pipeline<OrderCtx>('process-order')
  .addStep(validate)
  .addStep(charge)
  .onComplete((result) => metrics.emit('order.success', result))
  .onFailure((result) => metrics.emit('order.failure', result))
  .onCancel((result) => metrics.emit('order.cancel', result))
  .onSettled((result) => audit.log('order.settled', result));
```

- `onComplete` — the run succeeded (`result.ok === true`).
- `onFailure` — a step (or guard) failed; fires after rollback is complete.
- `onCancel` — the run was stopped by its `AbortSignal` (`result.aborted === true`); fires after
  rollback is complete.
- `onSettled` — **always** fires, last: the `finally` of the family.

`result.aborted` is what separates `onCancel` from `onFailure`. Lifecycle callbacks are
**observers** with the same containment as hooks: async callbacks are awaited, and a throwing
callback is caught and logged at `warn` — it never changes the `Result`, never re-triggers
rollback, and never stops the other callbacks. Dry-run plans fire no lifecycle events.

A full, runnable example combining parallel groups, composition, and lifecycle events lives in
[`examples/composition.ts`](./examples/composition.ts) — run it with `npm run example:composition`.

## Tracing

Pass a `tracer` to `execute` and a run emits spans. The interface is deliberately tiny and
vendor-neutral — four methods on a span — so the core keeps its zero-dependency guarantee and any
backend can be driven by implementing it:

```ts
interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: unknown): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}

interface Tracer {
  startSpan(name: string, parent?: TraceSpan): TraceSpan;
}
```

```ts
const result = await orderPipeline.execute(order, { tracer: myTracer });
```

Four kinds of span are produced:

| Span         | Name                                | Parent                       |
| ------------ | ----------------------------------- | ---------------------------- |
| Pipeline     | `penstock.pipeline ${pipelineName}` | none, or the `asStep` parent |
| Step         | `penstock.step ${stepName}`         | pipeline span                |
| Attempt      | `penstock.attempt ${stepName}#${n}` | step span                    |
| Compensation | `penstock.undo ${stepName}`         | pipeline span                |

Attempt spans appear **only when a step actually retries** (`maxAttempts > 1`) — for a single-attempt
step they would merely duplicate the step span. Every `StepReport` gets exactly one step span,
including skipped ones (which carry `penstock.step.skip_reason` and status `ok`), so a trace mirrors
`result.steps` one for one. Dry-run emits no spans at all.

Attributes are all namespaced `penstock.*`: `pipeline.name`, `execution.id`, `pipeline.step_count`,
`pipeline.ok`, `pipeline.aborted`, `pipeline.duration_ms`, `pipeline.rollback_error_count` on the
pipeline span; `step.name`, `step.idempotency_key`, `step.status`, `step.attempts`,
`step.duration_ms`, and `step.timed_out` / `step.skip_reason` where applicable on a step span. A span
whose step failed calls `recordException(error)` and `setStatus('error', message)`; successful and
skipped steps call `setStatus('ok')`.

**Attributes never contain your `input` or any context value** — only names, ids, statuses, counts,
durations, and the idempotency key.

**A broken tracer cannot break a pipeline.** Every tracer call is contained the same way hooks are:
a throw is caught, logged at `warn`, and the run continues unchanged. Every started span is `end()`ed
on every path — success, failure, rollback, cancellation, and guard throws alike.

Nested pipelines nest their traces: a `pipeline.asStep(...)` run parents its inner pipeline span to
the wrapping step's span, so one trace shows the whole composition. `ExecuteOptions.parentSpan` is
the mechanism, and you can use it directly to graft a penstock run onto a span your own code started.

### `penstock/otel`

A ready-made adapter onto OpenTelemetry ships as a separate entry point:

```ts
import { Pipeline } from 'penstock';
import { otelTracer } from 'penstock/otel';

const result = await pipeline.execute(input, { tracer: otelTracer() });
```

```sh
npm install @opentelemetry/api
```

`@opentelemetry/api` is an **optional peer dependency**: npm will not install it for you, so a
project that never imports `penstock/otel` installs nothing extra and the core stays
dependency-free. `otelTracer(options?)` takes `{ name?, version? }` to set the instrumentation scope,
defaulting to `'penstock'` and the penstock version.

A console tracer needing no OpenTelemetry install — plus bounded concurrency, a business-derived
idempotency key, and serialized output — is in
[`examples/production.ts`](./examples/production.ts) (`npm run example:production`).

## Serializing a Result

A `Result` holds live `Error` objects, an `AbortSignal`, and your context. `JSON.stringify` renders
every error as `{}` and throws outright on a circular reference, so a `Result` cannot be shipped to a
log aggregator as-is. `serializeResult(result)` returns a plain object that always survives
`JSON.stringify`:

```ts
import { serializeResult } from 'penstock';

logger.error('order failed', serializeResult(result));
```

- Errors flatten to `{ name, message, stack?, cause? }` plus their own custom fields, so
  `StepError.stepName` and your own error properties survive. `cause` chains are followed to
  `maxCauseDepth` (default `5`) and then simply stop.
- Anything thrown that is not an `Error` — `throw 'boom'`, `throw 42`, `throw null` — becomes
  `{ name: 'UnknownError', message }` rather than crashing the serializer.
- Circular references become `'[Circular]'`; values JSON cannot hold (`bigint`, symbols, functions)
  become `'[Unserializable]'`.
- `StepReport.innerResult` is serialized recursively under the same options.

**`context` is excluded by default.** That is a security decision, not an oversight: a serialized
`Result` is destined for a log aggregator, and contexts routinely hold PII, tokens, and payment
details. Opt in explicitly when you want it:

```ts
serializeResult(result, {
  includeContext: true, // default false
  includeStacks: false, // default true
  maxCauseDepth: 3, // default 5
});
```

It is a standalone function rather than a `Result.toJSON()` method, so `Result` stays a plain object
that deep-equality assertions and `structuredClone` keep working on. It never mutates its input.

## Dry-run

`execute(input, { dryRun: true })` **plans without executing**: it builds the context, evaluates each
guard, and reports the ordered plan with `'would-run'` / `'skipped'` statuses — **no `run` or `undo`
is ever called**. Guards are contractually pure, which is what makes this safe. `ok` stays `true`
unless a guard itself throws (then that step is `'failed'` and planning stops).

```ts
const plan = await onboarding.execute(input, { dryRun: true });
console.log(
  'steps:',
  plan.steps.map((s) => `${s.name}:${s.status}`).join(', '),
);
```

```text
steps: validate-signup:would-run, create-account:would-run, start-pro-trial:skipped, send-welcome-email:would-run
```

See [`examples/user-onboarding.ts`](./examples/user-onboarding.ts) (`npm run example:onboarding`).

## TypeScript

Every primitive is generic over your context type, so `ctx` is fully typed end to end. You define a
context that extends `BaseContext<TInput>`; `Pipeline<TContext>`, `Step<TContext>`, the hooks, and
`Result<TContext>` all share it, and `addStep` only accepts a `Step<TContext>`.

```ts
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string;
  total?: number;
}

new Step<OrderCtx>('calc', (ctx) => {
  ctx.input; // OrderInput (readonly)
  ctx.total; // number | undefined
  ctx.missing; // ✗ compile error — not declared on OrderCtx
});
```

Fields that steps populate mid-run are declared **optional** because they don't exist until their
step runs — this is the intended, type-honest pattern. Reach for the non-null assertion (`ctx.total!`)
in a downstream step once you know an earlier step has set the field.

## API reference

### `Step<TContext>`

- `new Step(name, runFn)` or
  `new Step(name, { run, when?, undo?, retry?, timeout?, idempotencyKey? })`. `name` must be a
  non-empty, non-reserved string; a missing `run` or an unsafe name throws `UsageError`.
- `run(ctx, meta) => void | Promise<void>` — the work; mutates `ctx`. `meta` is this invocation's
  `StepMeta`; declaring fewer parameters stays valid.
- `when(ctx) => boolean | Promise<boolean>` — optional pure guard; a falsy result skips the step.
  Guards receive no `meta`.
- `undo(ctx, meta) => void | Promise<void>` — optional compensation, run during rollback. Its
  `meta.idempotencyKey` is the run key plus `:undo`, `attempt`/`maxAttempts` are `1` (compensations
  are never retried), and `meta.signal` is the pipeline signal, not the step's timeout.
- `retry?: { attempts; delayMs?; backoff?; jitter? }` — re-invokes `run` on failure; `attempts` is
  total tries including the first, `backoff` is `'fixed'` (default) or `'exponential'` (see
  `RetryOptions`). Only `run` is retried.
- `timeout?: number` — per-attempt timeout in milliseconds (`> 0`); a timed-out attempt fails the
  step and sets `StepReport.timedOut`.
- `idempotencyKey?: string | ((ctx) => string)` — overrides the default key
  `` `${executionId}:${stepName}` ``. Resolved **once per invocation, before the first attempt**, and
  reused for every retry. A non-string, empty string, or other non-function value throws `UsageError`
  at construction; a key function that throws at run time is a step failure.
- `.when(fn)` — returns a **new** `Step` with the guard set (original untouched); replaces any prior
  guard rather than combining them.

### `StepMeta`

The second argument to `run` and `undo`, describing one invocation:

```ts
interface StepMeta {
  readonly stepName: string;
  readonly pipelineName: string;
  readonly executionId: string; // this execute() call
  readonly attempt: number; // 1-based
  readonly maxAttempts: number; // 1 when no retry is configured
  readonly idempotencyKey: string; // stable across every attempt
  readonly signal: AbortSignal; // this invocation's own signal
}
```

### `Pipeline<TContext>`

- `new Pipeline(name)` — non-empty, non-reserved name or `UsageError`.
- `.addStep(step)` — appends a sequential step; throws `UsageError` for a non-`Step` or a duplicate
  step name.
- `.addParallel(steps, options?)` — inserts a parallel group (the steps run concurrently, occupying
  one logical position). Requires **at least 2** `Step`s with pipeline-unique names, or `UsageError`.
  `options: ParallelOptions = { concurrency? }` caps how many run at once; it must be an integer
  `>= 1` (validated here, not at run time), and omitting it runs the whole group at once.
- `.asStep(name, options)` — wraps this whole pipeline as a single `Step` for use in an outer
  pipeline. `options: AsStepOptions = { mapInput; mapResult?; undo?; when? }` — `mapInput`
  (required) derives the inner input from the outer context; `mapResult` runs only on inner
  success; `undo` compensates the wrapping step during **outer** rollback (the inner pipeline is
  never re-rolled-back); `when` guards the wrapping step.
- `.before(hook)` / `.after(hook)` / `.onError(hook)` — register observer hooks (multiple allowed, run
  in registration order). Signatures: `before(ctx, step)`, `after(ctx, step, { status, durationMs })`,
  `onError(error, ctx, step)`. Hook throws are contained and never change the outcome.
- `.onComplete(cb)` / `.onFailure(cb)` / `.onCancel(cb)` / `.onSettled(cb)` — register lifecycle
  callbacks (each a `LifecycleCallback`: `(result: Result<TContext>) => void | Promise<void>`),
  fired once the run has settled, after any rollback: `onComplete` on success, `onFailure` on a
  step failure, `onCancel` on cancellation (`result.aborted` decides which), then `onSettled`
  always, last. Awaited, contained, none fire in dry-run.
- `.useEngine(engine)` — registers a pipeline-scoped engine (shadows a global of the same name).
- `.execute(input, options?)` — runs the flow, returns `Promise<Result<TContext>>`.
  `options: ExecuteOptions = { throwOnError?: boolean; dryRun?: boolean; logger?: Logger;
signal?: AbortSignal; tracer?: Tracer; parentSpan?: TraceSpan }`. `tracer` enables span emission
  (none without it, and none in dry-run); `parentSpan` parents this run's pipeline span to an
  existing span, which is how `asStep` nests inner runs.
- All builder methods are chainable.

### `Engine`

- `new Engine(name, methods)` — `name` non-empty/non-reserved; `methods` a non-empty record of
  functions. Otherwise `UsageError`.
- `registerEngine(engine)` — adds to the process-wide registry; re-registering a name throws
  `UsageError`.
- `clearEngines()` — empties the global registry (call it in `afterEach` in tests).
- `ctx.engines.<name>.<method>(...)` — resolves pipeline-scoped first, then global; an unknown name
  throws `UsageError`. Methods are typed as returning `unknown`.

### `UseCase<TInput>`

- `new UseCase(name)` — non-empty, non-reserved name or `UsageError`.
- `.addPipeline(pipeline)` — appends; rejects a non-`Pipeline` with `UsageError`. Chainable.
- `.execute(input)` — runs pipelines in order on the same input, returns
  `Promise<{ ok, pipelines, error }>`, short-circuiting on the first failure.

### `Logger`

`interface Logger { debug; info; warn; error }` — each `(msg: string, meta?: Record<string, unknown>)`.
The default is `noopLogger`; a `consoleLogger` is exported. Inject via `execute(input, { logger })`;
it's exposed at `ctx.logger`.

### Errors

- `PenstockError` — base class for all of the below.
- `UsageError` — synchronous misuse (bad construction, duplicate/unknown/reserved names).
- `StepError` — wraps a step `run` failure; carries `.stepName` and the original `.cause`.
- `PipelineError` — thrown by `execute` when `throwOnError`; carries `.result`, `.cause`, and an
  optional `.rollbackErrors` (`AggregateError`).

### `Result` & `StepReport`

```ts
interface Result<TContext> {
  ok: boolean; // false iff a step's run (or a guard) threw and the pipeline aborted
  context: TContext; // final context (post-execution / post-rollback)
  steps: StepReport[]; // one entry per step, in pipeline (declaration) order
  error: Error | null; // the step failure that aborted the pipeline, if any
  rollbackErrors: Error[]; // undo() failures gathered during compensation
  aborted: boolean; // true when the run was stopped by its AbortSignal
  executionId: string; // UUID for this execute() call; === context.executionId
  pipelineName: string; // so a Result is self-describing once detached
  durationMs: number; // total wall-clock for the call, rollback included
}

interface StepReport {
  name: string;
  status: StepStatus;
  durationMs: number; // 0 for skipped / would-run
  error?: Error; // present for 'failed' and 'rollback-failed'
  skipReason?: string; // present for 'skipped' — 'guard returned false',
  //   'cancelled', or 'cancelled (parallel peer failed)'
  attempts?: number; // times run was called; set for steps that ran (>= 1)
  timedOut?: boolean; // true when the step failed due to a timeout
  innerResult?: Result<any>; // the nested Result; pipeline-as-step entries only
  idempotencyKey?: string; // the key run was invoked under; steps that ran only
}

type StepStatus =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'would-run'; // dry-run only
```

### `serializeResult(result, options?)`

Flattens a `Result` into a plain, JSON-safe object (see
[Serializing a Result](#serializing-a-result)). `options: SerializeOptions =
{ includeContext?: boolean; includeStacks?: boolean; maxCauseDepth?: number }`, defaulting to
`false`, `true` and `5`. Returns a `SerializedResult` (with `SerializedStepReport` and
`SerializedError` for its parts). Pure: it never mutates the `Result`.

### Tracing

- `Tracer` / `TraceSpan` — the vendor-neutral interfaces you implement, exported from the root entry
  (see [Tracing](#tracing)).
- `otelTracer(options?)` — the OpenTelemetry adapter, exported from `penstock/otel`.
  `options: OtelTracerOptions = { name?: string; version?: string }` sets the instrumentation scope,
  defaulting to `'penstock'` and the penstock version. Requires the optional peer dependency
  `@opentelemetry/api`.

## Security model

Zero runtime dependencies. The optional `penstock/otel` adapter requires `@opentelemetry/api`, which
you install only if you use it — so penstock ships no transitive dependency tree. It performs **no
dynamic code execution** (no `eval`, `new Function`, `vm`, or dynamic import), and **no I/O,
telemetry, or environment scanning** — there is no data-exfiltration surface, and a tracer only ever
emits what you wired it to. All name-keyed lookups are `Map`/`Set`-backed and reserved names
(`__proto__`, `prototype`, `constructor`) are rejected, so it is **prototype-pollution safe**. It
**never logs your `input` or context values** — only names, statuses, durations, and error
message/type; the same rule governs trace attributes, and `serializeResult` excludes the context
unless you explicitly opt in. See [`SECURITY.md`](./SECURITY.md) to report a vulnerability.

## Why penstock exists

The pattern — use-cases composed of pipelines, pipelines of steps, steps calling engines — was
extracted from a real production ERP's orchestration layer, where reliable compensation when a
multi-step operation fails partway through was the hard part. penstock packages that pattern as a
small, generic, dependency-free library.

The name fits the shape: a penstock is the gated conduit that channels water under controlled
pressure to drive a turbine. The conduit is the pipeline, the gate is the conditional guard, the
controlled flow is sequential step execution — and it all exists to drive the turbine: the engine.

## Versioning

penstock follows [SemVer](https://semver.org/). The first release is `0.1.0`. **While in `0.x`, minor
versions may include breaking changes**; `1.0.0` will mark API stability. The
[changelog](./CHANGELOG.md) is hand-maintained in the _Keep a Changelog_ format.

## Roadmap

Post-MVP ideas, explicitly out of scope today:

- [x] Per-step retries with backoff
- [x] Per-step timeouts
- [x] `AbortSignal` cancellation between steps
- [x] Parallel step groups (`addParallel([...])`)
- [x] Pipeline-as-step composition (`pipeline.asStep(...)`)
- [x] Idempotency keys stable across retry attempts
- [x] Concurrency limits on parallel groups (`{ concurrency: n }`)
- [x] JSON-safe result serialization (`serializeResult`)
- [x] Tracing, with an optional OpenTelemetry adapter (`penstock/otel`)
- [ ] Cross-pipeline context flow in `UseCase`
- [ ] Richer dry-run that executes `sideEffectFree`-flagged steps
- [ ] DAG execution (inter-step dependencies)
- [ ] `changesets` for release automation

## License

[MIT](./LICENSE)
