---
title: Fan-out API calls with a concurrency cap
description: Five independent suppliers fetched concurrently, then the same group capped at two in flight — with the peak concurrency measured, not asserted.
sidebar:
  order: 3
---

## The problem

A dashboard needs five things from five different services. Fetching them one
after another takes the sum of their latencies for no reason — they do not
depend on each other.

Fetching all five at once is the obvious fix, and it is the right one until the
list is fifty, at which point you have opened fifty connections and the supplier
starts rate-limiting you.

## The code

`.parallel()` takes an array of [`defineStep`](../../guides/define-step/)
definitions, so each one is declared with its own name and output:

```ts
import { defineStep, pipeline } from 'penstock';

const forDashboard = defineStep<DashboardInput>();

const profile = forDashboard('profile', async () => ({
  profile: await supplier.fetch('profile', 40),
}));
const invoices = forDashboard('invoices', async () => ({
  invoices: await supplier.fetch('invoices', 30),
}));
const usage = forDashboard('usage', async () => ({
  usage: await supplier.fetch('usage', 20),
}));
const tickets = forDashboard('tickets', async () => ({
  tickets: await supplier.fetch('tickets', 50),
}));
const alerts = forDashboard('alerts', async () => ({
  alerts: await supplier.fetch('alerts', 10),
}));

const dashboard = pipeline<DashboardInput>('dashboard')
  .step('authorize', () => {})
  .parallel([profile, invoices, usage, tickets, alerts], { concurrency: 2 })
  .step('assemble', (ctx) => {
    // Every parallel step's contribution is here, all required.
    const parts = [ctx.profile, ctx.invoices, ctx.usage, ctx.tickets, ctx.alerts];
    return { widgets: parts.length };
  });
```

The stub supplier increments a counter on entry and decrements it on exit, so
the numbers below are **measured**, not claimed.

## The output

```text
=== unbounded: all five at once ===
    -> profile started (1 in flight)
    -> invoices started (2 in flight)
    -> usage started (3 in flight)
    -> tickets started (4 in flight)
    -> alerts started (5 in flight)
unbounded
  ok: true | widgets: 5
  peak concurrency: 5 | elapsed ~70ms
  report order: authorize, profile, invoices, usage, tickets, alerts, assemble

=== capped at 2 ===
    -> profile started (1 in flight)
    -> invoices started (2 in flight)
    -> usage started (2 in flight)
    -> tickets started (2 in flight)
    -> alerts started (2 in flight)
concurrency: 2
  ok: true | widgets: 5
  peak concurrency: 2 | elapsed ~110ms
  report order: authorize, profile, invoices, usage, tickets, alerts, assemble
```

*(Elapsed times vary run to run; the concurrency figures do not.)*

## Reading it

**The cap is real.** Unbounded, all five are in flight at once. Capped, the
counter never exceeds two — the remaining three wait in a bounded pool that
dispatches in declaration order as slots free.

**You pay for it in latency.** Roughly 70ms became roughly 110ms. That is the
trade: the cap exists to protect the supplier and your own connection pool, not
to go faster. Pick it from what the dependency can take, not from what looks
tidy.

**The report order is stable.** Both runs list the group in declaration order —
`profile, invoices, usage, tickets, alerts` — regardless of which finished
first. `alerts` completes first every time and is still reported last, so
assertions on `result.steps` do not flake.

**`assemble` sees all five keys, all required.** Every definition's contribution
is intersected into the accumulated type.

## Sizing the cap

Set it from the constraint you actually have: the supplier's documented rate
limit, your database connection pool size, or a memory ceiling if each task
buffers a response. `{ concurrency: n }` must be an integer `>= 1`, validated
when you build the pipeline rather than at run time. Omitting it, or setting it
at or above the group size, runs everything at once.

## When one supplier fails

The group cancels its peers, awaits everything to settlement, and then unwinds
in reverse declaration order. A step still **queued** under the cap is never
dispatched at all — its `run` is not called, and it reports `skipped` with
`skipReason: 'cancelled (parallel peer failed)'`.

If one supplier is allowed to fail without failing the dashboard, catch inside
that step and return a fallback rather than throwing:

```ts
const alerts = forDashboard('alerts', async () => {
  try {
    return { alerts: await supplier.fetch('alerts', 10) };
  } catch {
    return { alerts: null };
  }
});
```

## Give every step its own key

All five share one mutable context. Two steps writing the same key race, and the
types cannot catch it when both produce the same type. Each definition above
produces a distinctly named field — that is the rule, not a coincidence. See
[Context and typed state](../../concepts/context/).

## Next

- [Parallel groups and concurrency](../../guides/parallel/) — the full guide.
- [Reusable steps with `defineStep`](../../guides/define-step/) — why groups take definitions.
- [Background job with a timeout budget](../background-job/) — bounding the whole thing.
