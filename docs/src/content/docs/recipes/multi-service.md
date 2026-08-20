---
title: Multi-service transaction with compensation
description: One signup spanning identity, billing, and workspace provisioning — including the run where a compensation itself fails.
sidebar:
  order: 4
---

## The problem

Onboarding a customer commits to three services that know nothing about each
other: identity creates the user, billing starts the subscription, workspace
provisioning allocates their space. There is no transaction spanning all three.

Then the last hop fails, and you have three orphans in three systems.

The interesting case is not the tidy one. It is what happens when **one of the
compensations also fails** — the billing API is having the same bad afternoon
that broke activation in the first place. A hand-written `catch` block gets this
wrong: the first failing cleanup call throws, and the remaining cleanups never
run.

## The code

```ts
import { pipeline } from 'penstock';

const onboard = pipeline<SignupInput>('onboard-customer')
  .step('create-user', async (ctx) => ({
    userId: await identity.createUser(ctx.input.email),
  }))
  .undo(async (ctx) => identity.deleteUser(ctx.userId))
  .step('start-subscription', async (ctx) => ({
    subscriptionId: await billing.subscribe(ctx.userId, ctx.input.plan),
  }))
  .undo(async (ctx) => billing.cancel(ctx.subscriptionId))
  .step('provision-workspace', async (ctx) => ({
    workspaceId: await workspace.provision(ctx.userId),
  }))
  .undo(async (ctx) => workspace.destroy(ctx.workspaceId))
  .step('activate', () => {
    // The last hop fails, after all three services have committed.
    throw new Error('activation service unreachable');
  });
```

Each service's reversal lives next to the step that called it, and each one sees
that step's own output as required — `ctx.subscriptionId` is a `string` inside
the billing compensation, not `string | undefined`.

## The output

```text
=== all three services compensate, in reverse ===
    [workspace] destroyed ws_usr_ada
    [billing] cancelled sub_usr_ada_team
    [identity] deleted usr_ada
  ok: false | error: Step "activate" failed
    create-user          rolled-back
    start-subscription   rolled-back
    provision-workspace  rolled-back
    activate             failed
  rollbackErrors: []
  stores after: users:0 subs:0 spaces:0

=== the billing compensation itself fails ===
    [workspace] destroyed ws_usr_grace
    [identity] deleted usr_grace
  ok: false | error: Step "activate" failed
    create-user          rolled-back
    start-subscription   rollback-failed
    provision-workspace  rolled-back
    activate             failed
  rollbackErrors: ["billing API returned 503"]
  stores after: users:0 subs:1 spaces:0
```

## Reading it

**Reverse order, every time.** Workspace, then billing, then identity — the
exact reverse of creation. Deleting the user before cancelling their
subscription would leave billing pointing at a user that no longer exists.

**A broken compensation does not stop the others.** In the second run billing
threw, and `identity.deleteUser` still ran. The stores afterwards say
`users:0 subs:1 spaces:0` — **one** orphan, not three. This is the difference
that matters: best-effort compensation degrades, it does not collapse.

**The original error survives.** `result.error` is still
`Step "activate" failed`, not the billing 503. The thing that actually went
wrong stays the headline; the cleanup failure is recorded separately in
`rollbackErrors`, and the step that produced it is `rollback-failed` rather than
`rolled-back`.

**Three outcomes stay distinguishable.** The operation failed, the cleanup
failed, or both — a thrown exception flattens all three into one.

## What to do with the orphan

`rollbackErrors` is the signal that manual or deferred reconciliation is needed.
It is non-empty in exactly the case where automated cleanup did not fully
succeed, which makes it a precise alerting condition:

```ts
.onFailure((result) => {
  if (result.rollbackErrors.length > 0) {
    // Not just "a signup failed" — "a signup failed AND we could not clean up".
    pager.critical('onboarding left state behind', serializeResult(result));
  }
})
```

Pair it with `StepReport.status === 'rollback-failed'` to know *which* service
holds the orphan, and `result.context` for the id — the subscription id is right
there in the final context.

## Designing compensations across services

- **Make them idempotent.** A compensation may run against a service that never
  received the original call.
- **Do not throw for expected conditions.** "Already cancelled" is success.
  Throwing there manufactures a `rollback-failed` for no reason and buries the
  real ones.
- **Keep them narrow.** Each `undo` reverses *its* step. The reverse-order walk
  composes them for you; a compensation that tries to clean up two services is a
  compensation that can half-fail.
- **Compensations are never retried.** `meta.attempt` and `meta.maxAttempts` are
  both `1`. If a reversal deserves resilience, put the retry loop inside the
  function.

## Next

- [Rollback and compensation](../../guides/rollback/) — the full model.
- [Order processing saga](../order-saga/) — the same shape, four services.
- [Structured logging](../structured-logging/) — getting `rollbackErrors` somewhere useful.
