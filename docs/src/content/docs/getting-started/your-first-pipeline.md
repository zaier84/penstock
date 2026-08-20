---
title: Your first pipeline
description: Build a pipeline from two steps up to a working rollback, one stage at a time, with the printed Result at every step.
sidebar:
  order: 3
---

We will build one pipeline — user onboarding — in five stages. Each stage adds
one idea, and each shows the code and the output it actually prints.

Every snippet below is a complete file. Run it with
[`tsx`](https://tsx.is) (`npx tsx onboarding.ts`) or compile it as usual.

## 1. Two steps in order

A pipeline is a name and a chain of steps. Each step is a name and a function
that receives the context.

```ts
import { pipeline } from 'penstock';

interface SignupInput {
  email: string;
  plan: 'free' | 'pro';
}

const onboarding = pipeline<SignupInput>('onboarding')
  .step('validate', (ctx) => {
    if (!ctx.input.email.includes('@')) throw new Error('not an email address');
  })
  .step('create-account', (ctx) => {
    console.log(`creating account for ${ctx.input.email}`);
  });

const result = await onboarding.execute({
  email: 'ada@example.com',
  plan: 'pro',
});

console.log('ok:', result.ok);
for (const step of result.steps) {
  console.log(`  ${step.name}: ${step.status}`);
}
```

```text
creating account for ada@example.com
ok: true
  validate: completed
  create-account: completed
```

`pipeline<SignupInput>` fixes the input type for the whole chain, so
`ctx.input` is typed in every step. `execute()` builds a fresh context for this
call and resolves with a `Result` — note that it **resolves**, it does not
throw, even when things go wrong. We will see that in stage 4.

## 2. One step producing a value the next one uses

A step's return value is merged onto the context, and the context **type grows
with it**. This is the part that removes non-null assertions.

```ts
const onboarding = pipeline<SignupInput>('onboarding')
  .step('validate', (ctx) => {
    if (!ctx.input.email.includes('@')) throw new Error('not an email address');
  })
  .step('create-account', (ctx) => ({
    accountId: `acct_${ctx.input.email.split('@')[0]}`,
  }))
  .step('send-welcome', (ctx) => {
    // ctx.accountId is a string here. Not `string | undefined` — the step
    // above produced it, so by this point it exists.
    console.log(`emailing ${ctx.input.email} about ${ctx.accountId}`);
  });

const result = await onboarding.execute({
  email: 'ada@example.com',
  plan: 'pro',
});

console.log('accountId:', result.context.accountId);
```

```text
emailing ada@example.com about acct_ada
ok: true
accountId: acct_ada
  validate: completed
  create-account: completed
  send-welcome: completed
```

`result.context.accountId` is a `string` for the same reason. Try reading
`ctx.total` in `send-welcome` and the compiler stops you:

```text
error TS2339: Property 'total' does not exist on type
'TypedCtx<SignupInput, { accountId: string; }>'.
```

Returning nothing is fine too — `validate` contributes no keys, which is why
it returns nothing at all.

## 3. A step that only sometimes runs

`.when()` guards the step above it. The predicate must be pure: it is also what
dry-run evaluates when planning a pipeline without executing anything.

```ts
const onboarding = pipeline<SignupInput>('onboarding')
  .step('validate', (ctx) => {
    if (!ctx.input.email.includes('@')) throw new Error('not an email address');
  })
  .step('create-account', (ctx) => ({
    accountId: `acct_${ctx.input.email.split('@')[0]}`,
  }))
  .step('start-trial', () => ({ trialEndsAt: '2026-09-19' }))
  .when((ctx) => ctx.input.plan === 'pro')
  .step('send-welcome', (ctx) => {
    console.log(
      ctx.trialEndsAt === undefined
        ? `emailing ${ctx.input.email}`
        : `emailing ${ctx.input.email}, trial ends ${ctx.trialEndsAt}`,
    );
  });

for (const plan of ['pro', 'free'] as const) {
  console.log(`--- plan: ${plan} ---`);
  const result = await onboarding.execute({ email: 'ada@example.com', plan });
  for (const step of result.steps) {
    console.log(
      `  ${step.name}: ${step.status}${step.skipReason ? ` (${step.skipReason})` : ''}`,
    );
  }
}
```

```text
--- plan: pro ---
emailing ada@example.com, trial ends 2026-09-19
  validate: completed
  create-account: completed
  start-trial: completed
  send-welcome: completed
--- plan: free ---
emailing ada@example.com
  validate: completed
  create-account: completed
  start-trial: skipped (guard returned false)
  send-welcome: completed
```

Notice what the guard did to the types. Because `start-trial` may not run,
`ctx.trialEndsAt` in `send-welcome` is `string | undefined` — the compiler
forces the `undefined` branch that the free plan actually takes. A guarded
step's output is optional downstream, and the types say so rather than
pretending otherwise.

## 4. When a step fails

Let the mail provider fall over.

```ts
  .step('send-welcome', () => {
    throw new Error('mail provider returned 503');
  });
```

```text
ok: false
error: Step "send-welcome" failed
cause: mail provider returned 503
  validate: completed
  create-account: completed
  start-trial: completed
  send-welcome: failed
account still exists: acct_ada
```

The pipeline stopped, and `execute()` still resolved — `ok: false` rather than
a thrown exception. `result.error` is a `StepError` naming the step, and its
`cause` is the original error, unwrapped and intact.

Read the last line, though. **The account is still there.** Nothing has undone
the work that already succeeded, because we have not said how.

## 5. Undoing what already happened

`.undo()` chains onto the step it compensates. It sees that step's output as
**required**, because a compensation only ever runs for a step that completed.

```ts
const onboarding = pipeline<SignupInput>('onboarding')
  .step('validate', (ctx) => {
    if (!ctx.input.email.includes('@')) throw new Error('not an email address');
  })
  .step('create-account', (ctx) => ({
    accountId: `acct_${ctx.input.email.split('@')[0]}`,
  }))
  .undo((ctx) => {
    console.log(`deleting ${ctx.accountId}`);
  })
  .step('start-trial', () => ({ trialEndsAt: '2026-09-19' }))
  .when((ctx) => ctx.input.plan === 'pro')
  .undo((ctx) => {
    console.log(`cancelling trial ending ${ctx.trialEndsAt}`);
  })
  .step('send-welcome', () => {
    throw new Error('mail provider returned 503');
  });

const result = await onboarding.execute({
  email: 'ada@example.com',
  plan: 'pro',
});

console.log('rollbackErrors:', result.rollbackErrors.length);
```

```text
cancelling trial ending 2026-09-19
deleting acct_ada
ok: false
error: Step "send-welcome" failed
  validate: completed
  create-account: rolled-back
  start-trial: rolled-back
  send-welcome: failed
rollbackErrors: 0
```

Three things to read out of that output.

**The order is reversed.** The trial was cancelled before the account was
deleted, mirroring the order they were created in. You did not write that
ordering; it falls out of where the `.undo()` calls sit in the chain.

**`validate` stayed `completed`.** A step with no `undo` declares itself to
need no compensation, so rollback skips it rather than marking it rolled back.

**`rollbackErrors` is empty.** Had one of the compensations thrown, that step
would read `rollback-failed` and its error would appear here — while the
*other* compensations still ran. Rollback is best-effort by design: one broken
compensation must not strand the resources the others would release.

## What you have

A pipeline that validates, creates, conditionally starts a trial, sends mail,
and unwinds cleanly when any of it fails — with a machine-readable account of
every run.

From here:

- [Core concepts](../../concepts/steps/) — steps, pipelines, context, engines,
  and results, one page each.
- [Rollback and compensation](../../guides/rollback/) — the reverse-order,
  best-effort model in full.
- [Testing your pipelines](../../guides/testing/) — asserting on a `Result`
  instead of catching errors.
- [Why penstock](../../why-penstock/) — the reasoning behind the design, and
  when to use something else.
- [Migrating from the class API](../../migrating/) — if you have existing
  `Pipeline` and `Step` code.
- [API reference](../../reference/penstock/) — every export, generated from the
  source.
