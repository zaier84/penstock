---
title: Why penstock
description: The problem penstock solves, an honest account of when not to use it, and how it compares to Temporal, BullMQ, p-retry, Effect-TS, and plain async/await.
---

## The problem

You have an operation with several steps, each of which touches something
outside your process. Reserve stock, charge a card, book a courier. The third
one fails. The first two already happened.

Here is the version most of us write first.

```ts
async function checkout(order: Order) {
  let reservationId: string | undefined;
  let chargeId: string | undefined;

  try {
    reservationId = await reserve(order.items);
    chargeId = await charge(order.card, reservationId);
    await ship(chargeId);
  } catch (err) {
    // Unwind by hand, in reverse, guarding each one because we do not know
    // how far we got.
    if (chargeId) await refund(chargeId);
    if (reservationId) await release(reservationId);
    throw err;
  }
}
```

It works. It is also carrying three problems that get worse with every step you
add.

**Every new step costs four edits** — a variable, an assignment, an `if` in the
`catch`, and the mental check that the unwind order still mirrors the forward
order. Miss the reverse ordering and you refund a charge that gets re-created a
moment later.

**The unwind is itself unguarded.** Run the code above with a refund endpoint
that times out:

```text
reserving 1 line item(s)
charging tok_visa against rsv_1
caught: refund endpoint timed out
inventory still reserved: true
```

Two bugs in five lines of `catch`. The refund threw, so `release` never ran and
the stock is leaked. And because the new error propagated, the original
`carrier rejected` failure — the thing that actually went wrong — was silently
replaced by a symptom of the cleanup.

**The caller gets an exception, not an account.** Which steps ran? How long did
each take? Did the refund succeed? An exception carries none of it, so the
answers end up in log lines you grep for later.

The same pipeline in penstock, with the same failing refund:

```ts
const checkout = pipeline<Order>('checkout')
  .step('reserve-stock', async (ctx) => ({
    reservationId: await reserve(ctx.input.items),
  }))
  .undo(async (ctx) => release(ctx.reservationId))
  .step('charge-card', async (ctx) => ({
    chargeId: await charge(ctx.input.card, ctx.reservationId),
  }))
  .undo(async (ctx) => refund(ctx.chargeId))
  .step('ship', async (ctx) => {
    throw new Error(`carrier rejected ${ctx.chargeId}`);
  });

const result = await checkout.execute(order);
```

```text
reserving 1 line item(s)
charging tok_visa against rsv_1
released rsv_1
ok: false
error: Step "ship" failed
  reserve-stock: rolled-back
  charge-card: rollback-failed
  ship: failed
rollbackErrors: [ 'refund endpoint timed out' ]
inventory still reserved: false
```

The refund still failed — penstock cannot make a broken endpoint work. But the
release ran anyway, so the stock is not leaked; `result.error` is still the real
failure; and the refund's failure is recorded separately rather than replacing
it.

## What penstock gives you

- **Compensation declared next to the step it reverses.** `.undo()` chains onto
  the step above it and sees that step's output as required, so there is no `!`
  and no `if (chargeId)`. Rollback runs in reverse order, best-effort: a failing
  compensation is recorded and the rest still run.
- **A report of what happened.** `execute()` resolves with a `Result` — every
  step's status, duration, attempt count, and idempotency key, plus the causal
  error. Failure is data you can inspect, log, and assert on.
- **Reliability as policy.** Retry with fixed or exponential backoff,
  per-attempt timeouts, idempotency keys that stay stable across retries,
  parallel groups with a concurrency cap, and `AbortSignal` cancellation —
  configured per step rather than rewritten at each call site.
- **Context types that accumulate.** Each step declares what it produces and the
  context type grows down the chain. A field is required from the moment its
  step has run, so there is no shared interface of optional properties and no
  non-null assertions.
- **Nothing in your dependency tree.** Zero runtime dependencies, no I/O, no
  dynamic code execution.

## When to use it

Reach for penstock when an in-process operation has **several steps with side
effects** and you need **ordered rollback** when one of them fails; when you
want **per-step observability** without hand-rolling it; and when you
specifically do **not** want to run a workflow server to get those things.

## When not to use it

**Your operation has one step.** Call the function. A pipeline of one is
ceremony with no payoff.

**You have two or three steps and nothing to compensate.** Plain `async`/`await`
is genuinely better here, and you should write plain code. A sequence of awaits
that either completes or throws is easy to read, easy to test, and puts no
library between you and the work. penstock earns its keep at the point where you
are writing unwind logic by hand, tracking which steps completed, or repeating
retry boilerplate — not before.

**You need the work to survive a process restart.** penstock is in-process
state. If the machine dies mid-pipeline, the run is gone and nothing resumes.
Use Temporal, Restate, or Inngest.

**You need scheduling, or work distributed across processes.** penstock has no
queue, no scheduler, and no broker. Use BullMQ.

**You need a control plane across many services.** Long-running orchestration
spanning teams and deployments is Temporal's problem, not this library's.

**You are already committed to Effect-TS.** It covers this ground and a great
deal more. Adding penstock alongside it buys you nothing.

**Your steps are pure data transformations.** No side effects means nothing to
compensate. Compose functions.

## How it compares

**Plain `async`/`await`.** For a short sequence with no compensation, plain code
wins — fewer concepts, no dependency, and a stack trace that points straight at
your own code. The trade only happens when you start hand-writing the `catch`
block from the top of this page. If you are not writing that block, you do not
need this library.

**Temporal, Restate, Inngest.** These are durable execution engines: they
persist workflow state, so a crashed worker resumes where it left off and a
workflow can sleep for a month. **That is a real capability penstock does not
have and cannot fake.** What it costs is infrastructure or a hosted service, a
programming model constrained by determinism requirements, versioning discipline
for in-flight workflows, and the operational surface that comes with all of it.
penstock is an import with no server behind it. If durability is a requirement,
choose durability.

**BullMQ and job queues.** A different problem. Queues move work across
processes and time — scheduling, priorities, rate limits, retries at the job
level. They compose with penstock rather than competing with it: a queue handler
is a perfectly good place to run a pipeline.

**`p-retry`, `p-limit`, `p-timeout`.** Excellent, focused tools. If retry is the
only thing you need, `p-retry` is a smaller and better answer than adopting an
orchestration library. penstock's equivalents exist so they compose with
compensation and per-step reporting, not because the standalone ones are
lacking.

**Effect-TS.** Far more powerful — a full effect system with dependency
injection, structured concurrency, typed errors, and its own runtime. It is also
a whole-program paradigm with a real learning curve, and it tends to shape the
codebase around it. penstock is a focused library you can adopt in one file and
remove in an afternoon.

|                            | penstock           | Plain `async`/`await` | Temporal-class      | BullMQ-class queues | Effect-TS              |
| -------------------------- | ------------------ | --------------------- | ------------------- | ------------------- | ---------------------- |
| Durable across restarts    | No                 | No                    | **Yes**             | Yes, per job        | No                     |
| Requires infrastructure    | No                 | No                    | Yes                 | Yes — Redis         | No                     |
| Ordered compensation       | **Built in**       | By hand               | Built in            | By hand             | Via `acquireRelease`   |
| Retry policy               | Built in           | By hand               | Built in            | Built in            | Built in               |
| Parallel execution         | Built in, bounded  | `Promise.all`         | Built in            | Across workers      | Built in               |
| Per-step observability     | **Built in**       | By hand               | Built in            | Job-level           | Via tracing            |
| Typed context accumulation | **Built in**       | N/A                   | No                  | No                  | Via `Effect` channels  |
| Learning curve             | Small              | None                  | Large               | Moderate            | Large                  |
| Runtime dependencies       | **0**              | 0                     | Client SDK + server | Redis client        | Effect runtime         |

## Where it came from

The pattern — use-cases composed of pipelines, pipelines of steps, steps calling
engines — was extracted from a production ERP's orchestration layer, where
reliable compensation for half-finished multi-step operations was the part that
kept going wrong. penstock packages that pattern as a small, generic,
dependency-free library.

The name fits the shape. A penstock is the gated conduit that channels water
under controlled pressure to drive a turbine: the conduit is the pipeline, the
gate is the conditional guard, the controlled flow is sequential execution — and
all of it exists to drive the turbine, which is the engine.
