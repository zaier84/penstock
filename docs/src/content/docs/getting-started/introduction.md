---
title: Introduction
description: What penstock is, the four concepts it is built from, and what it deliberately does not do.
sidebar:
  order: 1
---

penstock turns a multi-step backend operation into a series of named, testable
steps that run in order — and, when one of them fails, walks backwards undoing
the ones that already succeeded. It is a library, not a service: you import it,
and there is nothing to deploy or operate.

Failure comes back as **data**. `execute()` resolves with a `Result` describing
what happened to every step — completed, skipped, failed, rolled back — with
durations, attempt counts, and the causal error. It does not throw unless you
ask it to. That makes a partial failure something you can inspect, log, and
write assertions about, instead of a stack trace you interpret after the fact.

The type layer is the other half. Each step declares what it **produces**, and
the context type accumulates down the chain, so a field is required from the
moment its step has run. There is no context interface to maintain and no
`ctx.total!` in a downstream step.

## The four concepts

**Step** — the atomic unit. A named async function that receives the shared
context and returns what it produces. It may declare a guard (`.when()`, a pure
predicate that skips it) and a compensation (`.undo()`, run during rollback).

**Pipeline** — an ordered, named chain of steps. It threads one context through
them, evaluates guards, fires observer hooks, and owns error handling and the
rollback chain. `execute()` builds a fresh context per call and resolves with a
`Result`.

**Engine** — a reusable, named bundle of domain functions that steps call via
`ctx.engines.<name>`. Engines sit outside the linear flow; they keep domain
logic out of step wiring.

**Context** — one mutable object created per `execute()` call and threaded by
reference through every step. penstock owns `input`, `engines`, `logger`,
`signal`, and `executionId`; your steps add to it by returning objects.

## What penstock does not do

It is worth being explicit, because these are the things people most often
assume a workflow library provides.

- **No durability.** State lives in memory for the duration of the call. If the
  process dies mid-pipeline, the run is gone and nothing resumes when it comes
  back. Durable execution is Temporal, Restate, or Inngest.
- **No scheduling or queueing.** There is no broker, no cron, no delayed jobs,
  and no cross-process distribution. That is BullMQ's job — and a queue handler
  is a good place to run a pipeline.
- **In-process only.** A pipeline is a function call. It does not span services,
  and it has no control plane.
- **No DAG.** Execution is sequential, with parallel groups at explicit points.
  Steps do not declare dependencies on each other.

If one of those is a requirement, [Why penstock](../../why-penstock/) sets out
which tool to use instead — including the case where plain `async`/`await` is
the better answer.

## Next

[Installation](../installation/), then
[Your first pipeline](../your-first-pipeline/), which builds one from two steps
up to a working rollback.
