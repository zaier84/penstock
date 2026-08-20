---
title: Roadmap
description: What has shipped, what is under consideration, and what has been dropped.
---

penstock is feature-complete for the problem it set out to solve. What follows
is an honest account of where it stands rather than a plan with dates.

## Shipped

- [x] Per-step retries with fixed or exponential backoff, and optional jitter
- [x] Per-step timeouts, applied per attempt
- [x] `AbortSignal` cancellation, checked between steps
- [x] Parallel step groups
- [x] Concurrency limits on parallel groups
- [x] Pipeline-as-step composition
- [x] Pipeline lifecycle events — `onComplete`, `onFailure`, `onCancel`, `onSettled`
- [x] Idempotency keys, stable across retry attempts
- [x] JSON-safe result serialization
- [x] Tracing, with an optional OpenTelemetry adapter
- [x] A typed builder whose context type accumulates across steps

## Under consideration

- [ ] **Richer dry-run** that actually executes steps flagged as side-effect
      free, rather than only planning. Today's dry-run evaluates guards and
      reports the plan without calling any `run`.
- [ ] **DAG execution**, where steps declare dependencies on one another
      instead of being ordered by position. This is the largest open idea and
      the one most likely to change the shape of the API, which is why it is
      not `1.0` work.
- [ ] **`changesets`** for release automation.

## Dropped

- **Cross-pipeline context flow in `UseCase`.** `UseCase` is deprecated as of
  `0.5.0`, superseded by [`.compose()`](../migrating/#usecase), which nests one
  pipeline inside another *and* passes data between them through `mapInput` and
  `mapResult`. Building data flow into a construct that is on its way out would
  be work in the wrong direction.

## Versioning

penstock follows [SemVer](https://semver.org/), and the first release was
`0.1.0`. **While in `0.x`, minor versions may include breaking changes**;
`1.0.0` will mark API stability. Every release is recorded in the
[changelog](https://github.com/zaier84/penstock/blob/main/CHANGELOG.md), which
is hand-maintained in the *Keep a Changelog* format.

What `1.0` will mean, concretely: the deprecated `UseCase` and global engine
registry are removed, the typed builder's API is frozen, and breaking changes
move to major versions only.
