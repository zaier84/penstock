---
title: Testing your pipelines
description: Asserting on the Result instead of catching errors, planning with dryRun, stubbing engines, forcing compensation, and where fake timers do and do not work.
sidebar:
  order: 14
---

Almost no orchestration library documents this, and it is the first thing you
need. The examples below are Vitest, but nothing here depends on Vitest beyond
`expect` and `vi` — every pattern works the same in Jest or `node:test`.

## Assert on the Result, not on a thrown error

This is the single habit that makes penstock pipelines pleasant to test.
`execute()` **resolves** on failure, so there is no `try`/`catch` and no
`rejects.toThrow` — the outcome is a value you can make precise assertions
about.

```ts
it('assert on the Result, not on a thrown error', async () => {
  const result = await buildCheckout(pricing).execute({
    id: 'ord_1',
    items: ['a', 'b'],
  });

  expect(result.ok).toBe(true);
  expect(result.context.total).toBe(200);
  expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
    'quote:completed',
    'reserve:completed',
    'charge:completed',
    'ship:completed',
  ]);
});
```

Mapping `steps` to `name:status` strings is the assertion worth reaching for
first. It pins the order, the set, and the outcome of every step in one line, and
when it fails the diff tells you exactly which step went wrong.

Avoid asserting on `durationMs` or `executionId`. They vary per run by design.

## Assert the plan with `dryRun`

Guard logic is where conditional pipelines go wrong, and `dryRun` tests it
**without stubbing a single dependency** — no `run` and no `undo` is called at
all.

```ts
it('asserts the plan with dryRun, running nothing', async () => {
  const plan = await buildCheckout(pricing).execute(
    { id: 'ord_2', items: [] },
    { dryRun: true },
  );

  expect(plan.ok).toBe(true);
  expect(plan.steps.map((s) => s.status)).toEqual([
    'would-run',
    'would-run',
    'would-run',
    'skipped',
  ]);
  expect(plan.steps[3]?.skipReason).toBe('guard returned false');
  expect(released).toEqual([]);
});
```

That last assertion is the point: nothing ran. A dry-run test costs nothing to
set up and catches the "why did that step not fire in production" class of bug
before it ships. See [Dry-run](../dry-run/).

## Stub engines with `useEngine`

An [engine](../../concepts/engines/) is a named bundle of domain functions, and
pipeline-scoped registration means a stub is just a different engine under the
same name — **with no global state and nothing to clean up in `afterEach`**:

```ts
it('stubs an engine with useEngine, no globals to clean up', async () => {
  const stub = new Engine('pricing', { quote: () => 999 });

  const result = await buildCheckout(stub).execute({
    id: 'ord_3',
    items: ['a'],
  });

  expect(result.context.total).toBe(999);
  expect(result.context.chargeId).toBe('chg_999');
});
```

The pattern that makes this work is building the pipeline in a **factory** that
takes its dependencies:

```ts
const buildCheckout = (engine: Engine) =>
  pipeline<Order>('checkout')
    .useEngine(engine)
    .step('quote', (ctx) => ({
      total: ctx.engines.pricing.quote(ctx.input) as number,
    }));
```

The deprecated `registerEngine` / `clearEngines` registry is process-wide mutable
state that leaks between suites unless every one of them remembers to clear it.
Not needing that teardown is the main practical reason `useEngine` replaced it.

## Force a failure to prove compensation ran

The compensation path is the part most likely to be wrong and least likely to be
exercised by accident. Test it by making a late step throw, then asserting on
both the statuses and the side effect:

```ts
it('forces a failure to prove compensation ran', async () => {
  const failing = pipeline<Order>('checkout')
    .step('reserve', () => ({ reservationId: 'rsv_1' }))
    .undo((ctx) => {
      released.push(ctx.reservationId);
    })
    .step('ship', () => {
      throw new Error('carrier rejected');
    });

  const result = await failing.execute({ id: 'ord_4', items: ['a'] });

  expect(result.ok).toBe(false);
  expect(result.error?.cause).toMatchObject({ message: 'carrier rejected' });
  expect(result.steps.map((s) => s.status)).toEqual(['rolled-back', 'failed']);
  expect(released).toEqual(['rsv_1']);
  expect(result.rollbackErrors).toEqual([]);
});
```

Four assertions worth making every time: the run failed, the **cause** is your
error (not a `StepError` wrapper — match on `.cause`), the statuses show reverse
compensation, and `rollbackErrors` is empty so no compensation silently broke.

To test the *failing compensation* path, make an `undo` throw and assert that
`rollbackErrors` has one entry and the other compensations still ran. That is the
behaviour a hand-written `catch` block gets wrong, so it is worth pinning.

## Fake timers work for retry

Inter-attempt delays use `setTimeout` from `node:timers/promises`, which fake
timers replace. Start the run, advance the clock, then await:

```ts
it('tests retry backoff with fake timers', async () => {
  vi.useFakeTimers();
  let calls = 0;

  const flaky = pipeline<Order>('sync')
    .step('call', () => {
      calls += 1;
      if (calls < 3) throw new Error('503');
      return { synced: true };
    })
    .retry({ attempts: 3, delayMs: 1000, backoff: 'exponential' });

  const running = flaky.execute({ id: 'ord_5', items: [] });
  await vi.advanceTimersByTimeAsync(3000);
  const result = await running;

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.attempts).toBe(3);
  vi.useRealTimers();
});
```

The ordering matters: kick off `execute()` **without awaiting it**, advance the
timers, and only then await the promise. Awaiting first would deadlock, because
the delay never elapses while the clock is frozen.

Advance by at least the total backoff — here `1000 + 2000` — and use
`advanceTimersByTimeAsync`, not the synchronous version, since the pipeline
awaits between attempts.

## Fake timers do **not** work for timeouts

Per-attempt timeouts use `AbortSignal.timeout()`, which is a platform primitive
that fake timers do not intercept. A test that freezes the clock and waits for a
timeout will hang until the test framework kills it.

**Use a real, small timeout instead.** Twenty milliseconds is plenty and costs
nothing:

```ts
it('tests a timeout with real timers, kept short', async () => {
  const slow = pipeline<Order>('fetch')
    .step('call', (_ctx, meta) =>
      sleep(1000, undefined, { signal: meta.signal }),
    )
    .timeout(20);

  const result = await slow.execute({ id: 'ord_6', items: [] });

  expect(result.ok).toBe(false);
  expect(result.steps[0]?.timedOut).toBe(true);
  expect(result.error?.cause).toMatchObject({ name: 'TimeoutError' });
});
```

Assert on `timedOut` rather than string-matching the error — that flag exists so
a timeout is distinguishable from any other failure without parsing messages.

Note the step forwards `meta.signal`. Without it the abandoned `sleep` keeps
running after the test finishes, which some runners report as an open handle.
See [Timeouts](../timeouts/).

## Test a reusable step on its own

A [`defineStep`](../define-step/) definition is a value, so a one-step pipeline is
enough to exercise it without the rest of the flow:

```ts
it('a reusable step definition is testable on its own', async () => {
  const validate = defineStep<Order>()('validate', (ctx) => {
    if (ctx.input.items.length === 0) throw new Error('empty order');
    return { validated: true };
  });

  const result = await pipeline<Order>('t').use(validate).execute({
    id: 'ord_7',
    items: [],
  });

  expect(result.ok).toBe(false);
  expect(result.steps[0]?.error?.cause).toMatchObject({
    message: 'empty order',
  });
});
```

## Testing cancellation

Abort the controller from inside a step, then assert on `aborted` and the skip
reasons:

```ts
const controller = new AbortController();
const p = pipeline<Job>('job')
  .step('start', () => {
    controller.abort(new Error('cancelled'));
  })
  .step('next', () => {});

const result = await p.execute(input, { signal: controller.signal });

expect(result.aborted).toBe(true);
expect(result.steps[1]?.skipReason).toBe('cancelled');
```

Aborting *before* `execute()` works too, and is the simpler test when you only
want to prove the run stops. See [Cancellation](../cancellation/).

## Testing composed pipelines

Test the inner pipeline directly — it is a pipeline. For the outer one, assert
that the wrapping step reports what you expect and, when it matters, reach into
`innerResult`:

```ts
const wrapper = result.steps.find((s) => s.name === 'run-inventory');
expect(wrapper?.innerResult?.steps.map((s) => s.status)).toEqual([
  'completed',
  'completed',
]);
```

Because a composed pipeline resolves its **own** engines, you stub the inner
one's dependencies on the inner pipeline. See [Composition](../composition/).

## Things worth asserting, and things not

| Assert | Do not assert |
| --- | --- |
| `result.ok`, `result.aborted` | `durationMs` — varies per run |
| `steps` mapped to `name:status` | `executionId` — a fresh UUID each call |
| `error.cause`, not the `StepError` wrapper | Exact stack contents |
| `attempts`, `timedOut`, `skipReason` | Wall-clock timing of a parallel group |
| `idempotencyKey` for anything that spends money | The default key's UUID half |
| `rollbackErrors` — usually that it is empty | |

## Next

- [Dry-run](../dry-run/) — planning in more depth.
- [Rollback and compensation](../rollback/) — the behaviour worth testing hardest.
- [Results and reporting](../../concepts/results/) — every field you can assert on.
