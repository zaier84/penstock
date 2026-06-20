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
step. The library owns `BaseContext` (`input`, `engines`, `logger`); you extend it with your own
working fields. Explicit shared context keeps data flow legible and decouples steps from each other's
signatures; the tradeoff (steps can overwrite each other's keys) is mitigated by naming discipline,
types, and tests.

```ts
interface OrderCtx extends BaseContext<OrderInput> {
  reservationId?: string; // populated by reserve-inventory
  total?: number; // populated by calculate-total
}
```

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

penstock adds three opt-in reliability controls: per-step **retry**, per-step **timeout**, and
pipeline-level **cancellation**. They compose — a single step can carry both `retry` and `timeout`,
and any pipeline can be cancelled mid-flight — and they never change behaviour unless you ask for
them.

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

### Cancellation

Pass an `AbortSignal` to `execute` and the pipeline stops when it aborts. The signal is checked
**between steps** — a step that is already running is never interrupted mid-flight; the _next_
between-step check stops the pipeline. On cancellation, completed steps are **rolled back** exactly
like a failure (reverse order, best-effort) and the abort reason is surfaced as `result.error`.

```ts
const controller = new AbortController();
const result = await orderPipeline.execute(order, {
  signal: controller.signal,
});
// ...elsewhere: controller.abort(new Error('customer cancelled'));
```

The same signal is forwarded onto `ctx.signal`, so a long-running step can observe it and bail out of
its own async work cooperatively (a timeout aborts `ctx.signal` the same way):

```ts
new Step<OrderCtx>('reindex', async (ctx) => {
  for (const batch of batches) {
    if (ctx.signal.aborted) return; // stop early on cancellation / timeout
    await indexer.write(batch);
  }
});
```

A full, runnable example combining all three lives in
[`examples/reliability.ts`](./examples/reliability.ts) — run it with `npm run example:reliability`.

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

- `new Step(name, runFn)` or `new Step(name, { run, when?, undo?, retry?, timeout? })`. `name` must
  be a non-empty, non-reserved string; a missing `run` or an unsafe name throws `UsageError`.
- `run(ctx) => void | Promise<void>` — the work; mutates `ctx`.
- `when(ctx) => boolean | Promise<boolean>` — optional pure guard; a falsy result skips the step.
- `undo(ctx) => void | Promise<void>` — optional compensation, run during rollback.
- `retry?: { attempts; delayMs?; backoff?; jitter? }` — re-invokes `run` on failure; `attempts` is
  total tries including the first, `backoff` is `'fixed'` (default) or `'exponential'` (see
  `RetryOptions`). Only `run` is retried.
- `timeout?: number` — per-attempt timeout in milliseconds (`> 0`); a timed-out attempt fails the
  step and sets `StepReport.timedOut`.
- `.when(fn)` — returns a **new** `Step` with the guard set (original untouched); replaces any prior
  guard rather than combining them.

### `Pipeline<TContext>`

- `new Pipeline(name)` — non-empty, non-reserved name or `UsageError`.
- `.addStep(step)` — appends; throws `UsageError` for a non-`Step` or a duplicate step name.
- `.before(hook)` / `.after(hook)` / `.onError(hook)` — register observer hooks (multiple allowed, run
  in registration order). Signatures: `before(ctx, step)`, `after(ctx, step, { status, durationMs })`,
  `onError(error, ctx, step)`. Hook throws are contained and never change the outcome.
- `.useEngine(engine)` — registers a pipeline-scoped engine (shadows a global of the same name).
- `.execute(input, options?)` — runs the flow, returns `Promise<Result<TContext>>`.
  `options: { throwOnError?: boolean; dryRun?: boolean; logger?: Logger; signal?: AbortSignal }`.
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
  steps: StepReport[]; // one entry per step, in pipeline order
  error: Error | null; // the step failure that aborted the pipeline, if any
  rollbackErrors: Error[]; // undo() failures gathered during compensation
}

interface StepReport {
  name: string;
  status: StepStatus;
  durationMs: number; // 0 for skipped / would-run
  error?: Error; // present for 'failed' and 'rollback-failed'
  skipReason?: string; // present for 'skipped' (e.g. 'cancelled')
  attempts?: number; // times run was called; set for steps that ran (>= 1)
  timedOut?: boolean; // true when the step failed due to a timeout
}

type StepStatus =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'would-run'; // dry-run only
```

## Security model

penstock has **zero runtime dependencies**, so it ships no transitive dependency tree. It performs
**no dynamic code execution** (no `eval`, `new Function`, `vm`, or dynamic import), and **no I/O,
telemetry, or environment scanning** — there is no data-exfiltration surface. All name-keyed lookups
are `Map`/`Set`-backed and reserved names (`__proto__`, `prototype`, `constructor`) are rejected, so
it is **prototype-pollution safe**. It **never logs your `input` or context values** — only names,
statuses, durations, and error message/type. See [`SECURITY.md`](./SECURITY.md) to report a
vulnerability.

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
- [ ] Parallel step groups (`addParallel([...])`)
- [ ] Cross-pipeline context flow in `UseCase`
- [ ] Richer dry-run that executes `sideEffectFree`-flagged steps
- [ ] DAG execution (inter-step dependencies)
- [ ] `changesets` for release automation

## License

[MIT](./LICENSE)
