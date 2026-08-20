---
title: Tracing and observability
description: A four-method vendor-neutral tracer, the span tree a run emits, every attribute it sets, and the OpenTelemetry adapter.
sidebar:
  order: 12
---

Pass a `tracer` to `execute` and the run emits spans. The interface is
deliberately tiny — four methods on a span — so the core keeps its
zero-dependency guarantee and any backend can be driven by implementing it.

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
const result = await checkout.execute(order, { tracer: myTracer });
```

No tracer, no spans. Dry-run emits none either way.

## The span tree

Four kinds of span:

| Span | Name | Parent |
| --- | --- | --- |
| Pipeline | `penstock.pipeline ${pipelineName}` | none, or the composing step |
| Step | `penstock.step ${stepName}` | the pipeline span |
| Attempt | `penstock.attempt ${stepName}#${n}` | the step span |
| Compensation | `penstock.undo ${stepName}` | the pipeline span |

A console tracer, written against nothing but the interface above, shows the real
shape of a failing run with a retry and a rollback:

```text
+ penstock.pipeline checkout
  + penstock.step reserve
    . penstock.step.status = completed
    = ok
  + penstock.step charge
    + penstock.attempt charge#1
      ! gateway declined
      = error
    + penstock.attempt charge#2
      ! gateway declined
      = error
    . penstock.step.status = failed
    ! Step "charge" failed
    = error
  + penstock.undo reserve
    . penstock.step.status = rolled-back
    = ok
  . penstock.pipeline.ok = false
  ! Step "charge" failed
  = error
```

Three things to notice.

**Attempt spans appear only when a step actually retries** (`maxAttempts > 1`).
For a single-attempt step they would merely duplicate the step span, so `reserve`
has none.

**Compensation spans hang off the pipeline span, not the step's.** The step's
span closed long before rollback began, and a compensation belongs to the
rollback phase.

**Every `StepReport` gets exactly one step span**, including skipped ones — which
carry `penstock.step.skip_reason` and status `ok`. A trace mirrors `result.steps`
one for one.

## Attributes

All namespaced `penstock.*`.

On the pipeline span: `pipeline.name`, `execution.id`, `pipeline.step_count`,
`pipeline.ok`, `pipeline.aborted`, `pipeline.duration_ms`,
`pipeline.rollback_error_count`.

On a step span: `step.name`, `step.idempotency_key`, `step.status`,
`step.attempts`, `step.duration_ms`, and `step.timed_out` / `step.skip_reason`
where applicable.

A span whose step failed calls `recordException(error)` and
`setStatus('error', message)`; successful and skipped steps call
`setStatus('ok')`.

**Attributes never contain your `input` or any context value** — only names, ids,
statuses, counts, durations, and the idempotency key. The one caveat is that key:
if you [derive it from sensitive data](../idempotency/), that data reaches your
tracing backend. Derive from identifiers.

## A broken tracer cannot break a pipeline

Every tracer call is contained the way hooks are: a throw is caught, logged at
`warn`, and the run continues unchanged. Every started span is `end()`ed on every
path — success, failure, rollback, cancellation, and guard throws alike.

## Nested pipelines nest their traces

A [`.compose()`](../composition/) run parents its inner pipeline span to the
wrapping step's span, so one trace shows the whole composition.
`ExecuteOptions.parentSpan` is the mechanism, and you can use it directly to
graft a penstock run onto a span your own code started:

```ts
await checkout.execute(order, { tracer, parentSpan: mySpan });
```

## `penstock/otel`

A ready-made OpenTelemetry adapter ships as a separate entry point:

```ts
import { otelTracer } from 'penstock/otel';

const result = await checkout.execute(order, { tracer: otelTracer() });
```

```sh
npm install @opentelemetry/api
```

`@opentelemetry/api` is an **optional peer dependency**: npm will not install it
for you, so a project that never imports `penstock/otel` installs nothing extra
and the core stays dependency-free. `otelTracer(options?)` takes
`{ name?, version? }` to set the instrumentation scope, defaulting to
`'penstock'` and the penstock version.

## Writing your own

Implementing `Tracer` is the whole integration. The console tracer that produced
the tree above is about twenty lines: track the depth of each span, print on
`startSpan`, and do something with `setAttribute`, `recordException`, and
`setStatus`.

That is also the reason the interface is this small. A four-method surface is one
you can implement in an afternoon against any backend, and it is a surface
penstock can guarantee it calls correctly on every path.

## Tracing versus logging versus the Result

Three different observation surfaces, and they answer different questions.
Tracing shows **timing and causality across services**. The
[logger](../serialization/) narrates **one run's lifecycle** as it happens. The
[`Result`](../../concepts/results/) is the **structured record** of what
happened, available to your code. Use the `Result` for control flow, the tracer
for latency investigation, and the logger for the narrative in between.

## Next

- [Serialization and logging](../serialization/) — getting a `Result` into logs.
- [Lifecycle events](../lifecycle-events/) — where to emit metrics.
- [Composition](../composition/) — nested traces.
