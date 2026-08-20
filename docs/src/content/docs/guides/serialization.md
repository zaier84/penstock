---
title: Serialization and logging
description: Getting a Result into a log aggregator intact — why JSON.stringify is not enough, and why the context is excluded by default.
sidebar:
  order: 13
---

A `Result` holds live `Error` objects, an `AbortSignal`, and your context.
`JSON.stringify` mangles all three. `serializeResult(result)` returns a plain
object that always survives it.

```ts
import { serializeResult } from 'penstock';

logger.error('order failed', serializeResult(result));
```

## What JSON.stringify does to an error

```text
naive JSON.stringify of result.error:
   {"name":"StepError","stepName":"charge"}
serializeResult error:
   {"name":"StepError","message":"Step \"charge\" failed","cause":{"name":"Error","message":"gateway declined"},"stepName":"charge"}
```

**The message is gone.** `Error.prototype.message` is a non-enumerable property,
so `JSON.stringify` skips it — and with it the `cause` chain that says what
actually went wrong. A log line built that way tells you a step named `charge`
failed and nothing else. `JSON.stringify` also throws outright on a circular
reference, which a context holding a parent-child object graph will hand it
sooner or later.

## What serializeResult guarantees

- **Errors flatten** to `{ name, message, stack?, cause? }` plus their own custom
  fields, so `StepError.stepName` and your own error properties survive. `cause`
  chains are followed to `maxCauseDepth` (default `5`) and then stop.
- **Non-`Error` throws** — `throw 'boom'`, `throw 42`, `throw null` — become
  `{ name: 'UnknownError', message }` rather than crashing the serializer.
- **Circular references** become `'[Circular]'`.
- **Values JSON cannot hold** — `bigint`, symbols, functions — become
  `'[Unserializable]'`.
- **`StepReport.innerResult`** is serialized recursively under the same options.

```text
circular -> "[Circular]"
bigint   -> "[Unserializable]"
```

It is pure: it never mutates the `Result`.

## The context is excluded by default

That is a **security decision, not an oversight**. A serialized `Result` is
destined for a log aggregator, and contexts routinely hold PII, tokens, and
payment details.

```text
context included by default: false
opted in, context keys: input, engines, logger, signal, executionId, reservationId, cardLast4
```

Opting in means opting into all of that — including `input`, the entire original
payload. Do it deliberately, and preferably not in a code path that logs on every
failure.

```ts
serializeResult(result, {
  includeContext: true, // default false
  includeStacks: false, // default true
  maxCauseDepth: 3, // default 5
});
```

`includeStacks: false` is worth considering for high-volume logging: stacks
dominate the payload size and rarely add anything the step name and cause chain
have not already told you.

## Why a function and not `Result.toJSON()`

A `toJSON` method would make `Result` a non-plain object, breaking deep-equality
assertions in tests and `structuredClone`. Keeping serialization external keeps
`Result` an ordinary object you can compare, clone, and destructure.

## Logging during a run

`serializeResult` is for the end. **During** a run, the `logger` you pass to
`execute` narrates the lifecycle:

```ts
import { consoleLogger } from 'penstock';

await checkout.execute(order, { logger: consoleLogger });
```

`Logger` is four methods — `debug`, `info`, `warn`, `error` — each taking
`(msg: string, meta?: Record<string, unknown>)`, so any structured logger adapts
in a few lines. The default is `noopLogger`; a `consoleLogger` is exported for
development. It is also exposed at `ctx.logger`, so steps can log through the
same one.

penstock logs step lifecycle at `debug`, contained hook and tracer errors at
`warn`, and rollback failures at `error`.

**The library never passes `ctx.input` or any context value to the logger** —
only names, statuses, durations, and error message and type. That guarantee is
enforced at the call sites and covered by a test in the repository. What your own
steps log through `ctx.logger` is your responsibility.

## A pattern that works

Log once per run, from `onSettled`, with the full serialized record:

```ts
const checkout = pipeline<Order>('checkout')
  .step('reserve', reserveStock)
  .step('charge', chargeCard)
  .onSettled((result) => {
    const record = serializeResult(result, { includeStacks: !result.ok });
    if (result.ok) logger.info('checkout settled', record);
    else if (result.aborted) logger.warn('checkout cancelled', record);
    else logger.error('checkout failed', record);
  });
```

One structured record per run, with stacks only when something went wrong, and
the cancellation case separated from the failure case so it does not page anyone.

## Next

- [Lifecycle events](../lifecycle-events/) — where that pattern hangs.
- [Results and reporting](../../concepts/results/) — what is being serialized.
- [Security model](../../security/) — the log-hygiene guarantee in full.
