# penstock

> Composable, testable backend workflows for Node.js — pipelines, steps, and engines, with first-class reverse-order rollback.

[![npm version](https://img.shields.io/npm/v/penstock.svg)](https://www.npmjs.com/package/penstock)
[![CI](https://github.com/zaier84/penstock/actions/workflows/ci.yml/badge.svg)](https://github.com/zaier84/penstock/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/penstock.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/penstock?activeTab=dependencies)
[![provenance](https://img.shields.io/badge/provenance-enabled-blue.svg)](https://docs.npmjs.com/generating-provenance-statements)
[![docs](https://img.shields.io/badge/docs-online-blue.svg)](https://zaier84.github.io/penstock/)

penstock turns a multi-step backend operation into named, testable steps that run in order — and,
when one of them fails, walks backwards undoing the ones that already succeeded. Failure comes back
as data: a structured `Result` reports which steps ran, were skipped, failed, or rolled back, with
timings and the causal error. It has **zero runtime dependencies**, ships dual **ESM + CommonJS**
builds, and its context type **accumulates** down the chain, so a field is required from the moment
its step has run.

**📖 [Documentation](https://zaier84.github.io/penstock/)** · [Why penstock](https://zaier84.github.io/penstock/why-penstock/) · [Getting started](https://zaier84.github.io/penstock/getting-started/introduction/) · [API reference](https://zaier84.github.io/penstock/reference/penstock/)

## Install

```sh
npm install penstock
```

## A pipeline that undoes itself

```ts
import { pipeline } from 'penstock';

const checkout = pipeline<Order>('checkout')
  .step('reserve-stock', async (ctx) => ({
    reservationId: await reserve(ctx.input.items),
  }))
  .undo(async (ctx) => release(ctx.reservationId))
  .step('charge-card', async (ctx) => ({
    // ctx.reservationId is a string here — no `!`, no optional chaining.
    chargeId: await charge(ctx.input.card, ctx.reservationId),
  }))
  .undo(async (ctx) => refund(ctx.chargeId))
  .step('ship', async (ctx) => {
    throw new Error(`carrier rejected ${ctx.chargeId}`);
  });

const result = await checkout.execute({
  items: [{ sku: 'A-1', qty: 2 }],
  card: 'tok_visa',
});

console.log('ok:', result.ok);
console.log('error:', result.error?.message);
for (const step of result.steps) {
  console.log(`  ${step.name}: ${step.status}`);
}
```

```text
reserving 1 line item(s)
charging tok_visa against rsv_1
refunded chg_1
released rsv_1
ok: false
error: Step "ship" failed
  reserve-stock: rolled-back
  charge-card: rolled-back
  ship: failed
```

Shipping failed, so the charge was refunded and the stock released — in that order, without a line
of unwind logic. `ctx.reservationId` is a `string` inside `charge-card` because the step above
produced it, and the failure came back as a value rather than a throw.

[**Your first pipeline**](https://zaier84.github.io/penstock/getting-started/your-first-pipeline/)
builds this up one stage at a time, with the printed `Result` at each.

## Why penstock

- **Compensation is declared next to the step it reverses.** `.undo()` chains onto the step above it
  and sees that step's output as required. Rollback runs in reverse order, best-effort — a failing
  compensation is recorded, and the rest still run.
- **Failure is data, not an exception.** `execute()` resolves with a `Result`: every step's status,
  duration, attempt count, and idempotency key, plus the causal error. Inspect it, log it, assert on
  it.
- **Reliability is policy.** Retry with backoff, per-attempt timeouts, idempotency keys stable across
  retries, bounded-concurrency parallel groups, and `AbortSignal` cancellation — configured per step
  rather than rewritten at each call site.
- **Types accumulate.** Each step declares what it produces and the context type grows with it. No
  context interface to maintain, and no `ctx.total!` downstream.

[**Why penstock**](https://zaier84.github.io/penstock/why-penstock/) makes the full case — including
an honest account of when _not_ to use it, and how it compares to Temporal, BullMQ, `p-retry`,
Effect-TS, and plain `async`/`await`.

## Features

- **[Rollback and compensation](https://zaier84.github.io/penstock/guides/rollback/)** — reverse-order, best-effort, with failures recorded rather than
  thrown.
- **[Retry](https://zaier84.github.io/penstock/guides/retry/)** — fixed or exponential backoff, optional jitter, per step.
- **[Timeouts](https://zaier84.github.io/penstock/guides/timeouts/)** — bound a single attempt; composes with retry.
- **[Idempotency keys](https://zaier84.github.io/penstock/guides/idempotency/)** — resolved once per invocation and stable across every retry.
- **[Cancellation](https://zaier84.github.io/penstock/guides/cancellation/)** — pass an `AbortSignal`; completed steps roll back exactly as on failure.
- **[Parallel groups](https://zaier84.github.io/penstock/guides/parallel/)** — run independent steps concurrently, with an optional concurrency cap.
- **[Composition](https://zaier84.github.io/penstock/guides/composition/)** — nest a whole pipeline as one step, with typed data flow in and out.
- **[Lifecycle events](https://zaier84.github.io/penstock/guides/lifecycle-events/)** — `onComplete`, `onFailure`, `onCancel`, `onSettled`, fired after any
  rollback.
- **[Dry-run](https://zaier84.github.io/penstock/guides/dry-run/)** — evaluate guards and report the plan without calling a single `run`.
- **[Tracing](https://zaier84.github.io/penstock/guides/tracing/)** — a four-method vendor-neutral interface, plus a ready-made `penstock/otel` adapter.
- **[Serialization](https://zaier84.github.io/penstock/guides/serialization/)** — `serializeResult()` produces a JSON-safe object, context excluded by default.
- **[Engines](https://zaier84.github.io/penstock/concepts/engines/)** — reusable, named bundles of domain functions, scoped per pipeline.
- **[Reusable steps](https://zaier84.github.io/penstock/guides/define-step/)** — `defineStep()` definitions that can declare the state they require.

## Documentation

- [Getting started](https://zaier84.github.io/penstock/getting-started/introduction/) — introduction,
  installation, and a five-stage tutorial.
- [Core concepts](https://zaier84.github.io/penstock/concepts/steps/) — steps, pipelines, context, engines,
  and results.
- [Guides](https://zaier84.github.io/penstock/guides/rollback/) — fourteen pages, one feature each,
  including [testing your pipelines](https://zaier84.github.io/penstock/guides/testing/).
- [Why penstock](https://zaier84.github.io/penstock/why-penstock/) — the problem, the comparisons,
  and when to use something else.
- [Migrating from the class API](https://zaier84.github.io/penstock/migrating/) — the typed-builder
  equivalent of every `Pipeline` and `Step` construct.
- [API reference](https://zaier84.github.io/penstock/reference/penstock/) — every export, generated
  from the source.
- [Security model](https://zaier84.github.io/penstock/security/) ·
  [Roadmap](https://zaier84.github.io/penstock/roadmap/) · [Changelog](./CHANGELOG.md)
- [Runnable examples](./examples) — six complete programs in this repository.

## Requirements

Node `>=20` (Node 22+ recommended). Dual **ESM + CommonJS** builds with bundled TypeScript types;
`strict` mode is recommended, since it is what makes the accumulated context types binding.

**Zero runtime dependencies.** The optional `penstock/otel` adapter requires `@opentelemetry/api`,
declared as an optional peer dependency and installed only if you use it.

## Security

penstock performs **no dynamic code execution**, **no I/O**, and **no telemetry**; every name-keyed
lookup is `Map`/`Set`-backed and reserved names (`__proto__`, `prototype`, `constructor`) are
rejected, so it is prototype-pollution safe. It **never logs your `input` or context values** — only
names, statuses, durations, and error message/type — and `serializeResult` excludes the context
unless you opt in; the [full security model](https://zaier84.github.io/penstock/security/) has the
details, and [`SECURITY.md`](./SECURITY.md) is how to report a vulnerability.

## Versioning

penstock follows [SemVer](https://semver.org/); the first release was `0.1.0`. **While in `0.x`,
minor versions may include breaking changes**; `1.0.0` will mark API stability. The
[changelog](./CHANGELOG.md) is hand-maintained in the _Keep a Changelog_ format, and what is shipped,
under consideration, and dropped is on the
[roadmap](https://zaier84.github.io/penstock/roadmap/).

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the local
workflow, the quality gates every change must pass, and the commit conventions.

## License

[MIT](./LICENSE)
