# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While in `0.x`, minor versions may include breaking changes.

## [0.1.0] - 2026-06-06

### Added

- `Step` — the atomic unit of work, with an optional `when` guard and `undo`
  compensation; immutable `.when(fn)` returns a configured clone.
- `Pipeline` — sequential execution that threads one typed context through its
  steps, with guard-based skipping, `before` / `after` / `onError` observer
  hooks, and **best-effort, reverse-order rollback** when a step fails.
- `Engine` — reusable named bundles of domain functions, with a `Map`-backed
  global registry (`registerEngine` / `clearEngines`) and pipeline-scoped
  `useEngine`; `ctx.engines` throws on unknown names.
- `UseCase` — a thin composition that runs pipelines sequentially on the same
  input, short-circuiting on the first failure.
- Dry-run planning (`execute(input, { dryRun: true })`) that evaluates guards
  without running any step.
- Structured `Result` / `StepReport` outcome, opt-in `throwOnError`, an
  injectable `Logger` (`noopLogger`, `consoleLogger`), and a small error
  hierarchy (`PenstockError`, `PipelineError`, `StepError`, `UsageError`).
- Full TypeScript types, dual ESM + CommonJS builds, and **zero runtime
  dependencies**.

[0.1.0]: https://github.com/zaier84/penstock/releases/tag/v0.1.0

## [0.1.1] - 2026-06-06

### Fixed

- Release pipeline configured with OIDC trusted publishing and provenance

[0.1.1]: https://github.com/zaier84/penstock/releases/tag/v0.1.1

## [0.1.2] - 2026-06-15

### Fixed

- `ctx.engines` now returns `undefined` for symbol-keyed property access instead
  of throwing, so inspecting a context (e.g. `console.log(ctx)`) no longer raises
  a spurious `Unknown engine` error. Unknown string engine names still throw a
  `UsageError`.

[0.1.2]: https://github.com/zaier84/penstock/releases/tag/v0.1.2

## [0.2.0] - 2026-06-21

### Added

- Per-step retry with configurable attempts, delay, fixed/exponential
  backoff, and optional jitter (`retry` option on `Step`).
- Per-step timeout using `AbortSignal.timeout()` (`timeout` option on
  `Step`, applies per attempt).
- Pipeline-level cancellation via `AbortSignal` passed to `execute()`.
- `ctx.signal: AbortSignal` always present on context; forwards timeout
  and cancellation into step `run` functions.
- `StepReport.attempts` — number of times `run` was called.
- `StepReport.timedOut` — `true` when the step failed due to a timeout.
- `RetryOptions` exported as a public type.

[0.2.0]: https://github.com/zaier84/penstock/releases/tag/v0.2.0

## [0.2.1] - 2026-07-02

### Fixed

- Cancelling a pipeline while a step with a `timeout` was running is now
  reported as a cancellation instead of a step failure. Such a step's
  `run` is no longer interrupted by the cancel — only its timeout can
  abort it — and remaining steps are skipped as `'cancelled'`, completed
  steps roll back, and the abort reason is surfaced verbatim on
  `result.error`, matching steps without a timeout.

[0.2.1]: https://github.com/zaier84/penstock/releases/tag/v0.2.1
