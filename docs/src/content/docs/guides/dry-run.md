---
title: Dry-run
description: Plan a pipeline without executing it — evaluate guards, report the ordered plan, call no run and no undo.
sidebar:
  order: 11
---

`execute(input, { dryRun: true })` **plans without executing**. It builds the
context, evaluates each guard, and reports the ordered plan with `would-run` and
`skipped` statuses. **No `run` and no `undo` is ever called.**

```ts
const onboarding = pipeline<Signup>('onboarding')
  .step('validate', () => {
    console.log('this never runs in a dry-run');
  })
  .step('create-account', () => ({ accountId: 'acct_1' }))
  .undo(() => {
    console.log('nor does this');
  })
  .step('start-trial', () => ({ trialEndsAt: '2026-09-19' }))
  .when((ctx) => ctx.input.plan === 'pro')
  .step('send-welcome', () => {});

const plan = await onboarding.execute(input, { dryRun: true });
```

```text
plan=pro ok=true
  validate        would-run
  create-account  would-run
  start-trial     would-run
  send-welcome    would-run
plan=free ok=true
  validate        would-run
  create-account  would-run
  start-trial     skipped    guard returned false
  send-welcome    would-run
```

Neither `console.log` fired. The guard, and only the guard, was evaluated.

## Why this is safe

Guards are **contractually pure predicates**. That contract is what dry-run
depends on, and it is why guards receive no `meta` — no attempt number, no
idempotency key, nothing that would invite a side-effectful guard.

If a guard writes to a database, dry-run writes to a database. Keep them pure.

## What a plan contains

`ok` stays `true` unless a **guard itself throws**, in which case that step is
`failed`, planning stops there, and `ok` is `false`. Everything else about the
`Result` is as usual: `pipelineName`, `executionId`, `durationMs`, and a
`StepReport` per step.

`durationMs` on a planned step is `0`, and there is no `attempts` or
`idempotencyKey` — nothing ran.

Parallel groups are planned too: their guards are evaluated **sequentially, in
declaration order**, and their members appear in the plan in that order.

Hooks, lifecycle callbacks, and trace spans are all **execution** observers, so
none of them fire while planning. A dry-run emits no spans even with a tracer
supplied.

## What to use it for

**Asserting the shape of a conditional pipeline in tests.** This is the main use.
Guard logic is where conditional flows go wrong, and dry-run tests it without
stubbing a single dependency:

```ts
const plan = await checkout.execute(freeOrder, { dryRun: true });
expect(plan.steps.map((s) => s.status)).toEqual([
  'would-run',
  'would-run',
  'would-run',
  'skipped',
]);
expect(plan.steps[3]?.skipReason).toBe('guard returned false');
```

See [Testing your pipelines](../testing/).

**Showing a user what is about to happen.** A "this will send 240 emails and
archive 12 records" confirmation, built from the plan rather than from a
hand-maintained description that drifts.

**Debugging a pipeline that skipped something unexpectedly.** The plan tells you
which guard returned false without you adding logging to find out.

## What it is not

It is not a simulation. It answers "which steps would run, given this input", not
"what would the result be" — the context stays empty of anything steps produce,
because no step ran to produce it. A guard reading a key an earlier step would
have produced sees it absent.

That is a real limitation, and it is why a richer dry-run that actually executes
steps flagged as side-effect free is on the [roadmap](../../roadmap/).

## Next

- [Testing your pipelines](../testing/) — dry-run as a testing tool.
- [Steps](../../concepts/steps/) — why guards take no `meta`.
- [Results and reporting](../../concepts/results/) — the `would-run` status.
