---
title: End-to-end OpenTelemetry
description: Wiring penstock/otel into a real OpenTelemetry setup, and the span tree an exporter actually receives.
sidebar:
  order: 8
---

## The problem

You already run OpenTelemetry. You want penstock's pipeline, step, attempt, and
compensation spans to appear inside your existing traces, parented correctly,
with attributes you can query — without penstock itself taking a dependency on
the OTel SDK.

## The wiring

Two lines. Install the optional peer dependency, and pass the adapter:

```sh
npm install @opentelemetry/api
```

```ts
import { pipeline } from 'penstock';
import { otelTracer } from 'penstock/otel';

const result = await checkout.execute(order, {
  tracer: otelTracer({ name: 'my-service' }),
});
```

`@opentelemetry/api` is an **optional** peer dependency: npm will not install it
for you, and a project that never imports `penstock/otel` gets nothing extra.
`otelTracer({ name, version })` sets the instrumentation scope — how a backend
attributes spans to the library that produced them — defaulting to `'penstock'`
and the penstock version.

Nothing in the pipeline itself knows about OpenTelemetry:

```ts
const checkout = pipeline<{ orderId: string }>('checkout')
  .step('reserve-stock', () => ({ reservationId: 'rsv_1' }))
  .undo(() => {})
  .step('charge-card', () => {
    throw new Error('gateway declined');
  })
  .retry({ attempts: 2, delayMs: 5 })
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}`);
```

## Registering the SDK

**Not executed** — the SDK and an exporter are two more dependencies, and this
repository ships with neither. This is the standard Node setup, loaded before
your application code:

```ts
// tracing.ts — imported first, e.g. `node --import ./tracing.js app.js`
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'checkout-service' }),
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }),
});

sdk.start();
process.on('SIGTERM', () => void sdk.shutdown());
```

Once an SDK is registered, `otelTracer()` picks it up through the global
provider — there is nothing to pass between them.

The runnable version of this recipe registers a **minimal in-process
`TracerProvider`** instead, so the tree below is produced by the real
`@opentelemetry/api`, with real parenting, and printed rather than exported.

## The span tree an exporter receives

```text
run: ok=false

=== spans, as the exporter would see them ===
penstock.pipeline checkout  [error] !Step "charge-card" failed
  penstock.execution.id = f9009d1a-d4b7-43fe-9d6c-9660d1a2ad65
  penstock.pipeline.aborted = false
  penstock.pipeline.duration_ms = 9.740599999999972
  penstock.pipeline.name = checkout
  penstock.pipeline.ok = false
  penstock.pipeline.rollback_error_count = 0
  penstock.pipeline.step_count = 2
  penstock.step reserve-stock  [ok]
    penstock.step.attempts = 1
    penstock.step.duration_ms = 0.5641000000000531
    penstock.step.idempotency_key = f9009d1a-d4b7-43fe-9d6c-9660d1a2ad65:reserve-stock
    penstock.step.name = reserve-stock
    penstock.step.status = completed
  penstock.step charge-card  [error] !Step "charge-card" failed
    penstock.step.attempts = 2
    penstock.step.duration_ms = 7.1317000000000235
    penstock.step.idempotency_key = charge:ord_5
    penstock.step.name = charge-card
    penstock.step.status = failed
    penstock.attempt charge-card#1  [error] !gateway declined
    penstock.attempt charge-card#2  [error] !gateway declined
  penstock.undo reserve-stock  [ok]
    penstock.step.name = reserve-stock
    penstock.step.status = rolled-back
```

## Reading it

**Attempt spans only appear where a step retried.** `reserve-stock` ran once and
has none; `charge-card` has two, each carrying its own exception. That is how
you see retry pressure in a latency waterfall rather than inferring it.

**The compensation is a sibling of the steps, not a child.** `penstock.undo
reserve-stock` hangs off the pipeline span, because the step's span closed long
before rollback began. Rollback is its own phase of the run and the trace says
so.

**`penstock.execution.id` correlates everything.** It is the same value as
`result.executionId` and the one in your [log records](../structured-logging/),
so a trace and its logs join on one field.

**The idempotency key is right there.** `charge:ord_5` — the business-derived
key from the pipeline. Which is also the warning: a key derived from a card
number or an email address would be sitting in your tracing backend now. Derive
keys from identifiers. See [Idempotency](../../guides/idempotency/).

**Attributes carry nothing else of yours.** Names, ids, statuses, counts,
durations, and that key. Never `ctx.input`, never a context value.

## Nesting inside your own spans

A [composed](../../guides/composition/) pipeline parents its inner pipeline span
to the wrapping step's span automatically. To graft a whole run onto a span your
own code started, pass `parentSpan`:

```ts
await checkout.execute(order, { tracer, parentSpan: mySpan });
```

## A broken exporter cannot break a pipeline

Every tracer call is contained the way hooks are: a throw is caught, logged at
`warn`, and the run continues unchanged. Every started span is `end()`ed on
every path — success, failure, rollback, cancellation, and guard throws alike.
Dry-run emits no spans at all.

## If you do not use OpenTelemetry

`Tracer` is four methods on a span. The [tracing guide](../../guides/tracing/)
shows a console tracer in about twenty lines, and any backend is the same shape
of work.

## Next

- [Tracing and observability](../../guides/tracing/) — every span and attribute.
- [Structured logging](../structured-logging/) — the other half of the picture.
- [Idempotency](../../guides/idempotency/) — the one attribute you control.
