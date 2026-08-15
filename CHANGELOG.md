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

## [0.3.0] - 2026-07-03

### Added

- Parallel step groups (`addParallel`) with concurrent execution and
  saga-pattern rollback when any parallel step fails.
- Pipeline-as-step composition (`Pipeline.asStep()`) for nested, hierarchical
  workflow architectures with isolated contexts and rollback propagation.
- Pipeline lifecycle events (`onComplete`, `onFailure`, `onCancel`,
  `onSettled`) for clean observability.
- `Result.aborted` field to programmatically distinguish cancellation from
  step failure.
- `StepReport.innerResult` for inspecting nested pipeline execution.
- `AsStepOptions` and `LifecycleCallback` exported types.

[0.3.0]: https://github.com/zaier84/penstock/releases/tag/v0.3.0

## [0.4.0] - 2026-08-15

### Added

- Execution identity — `ctx.executionId`, a UUID generated per `execute()` call and surfaced as
  `Result.executionId`, correlating a run's logs, traces, and default idempotency keys.
- `StepMeta` — a second argument to every `run` and `undo` carrying `stepName`, `pipelineName`,
  `executionId`, `attempt`, `maxAttempts`, `idempotencyKey`, and this invocation's own `signal`.
  Single-argument `run` functions are unaffected.
- Idempotency keys — every step invocation has one, defaulting to `` `${executionId}:${stepName}` ``
  and overridable per step with `idempotencyKey: string | ((ctx) => string)`. Resolved once before
  the first attempt and reused for every retry; a compensation gets the run key plus `:undo`.
- Concurrency limits on parallel groups — `addParallel(steps, { concurrency: n })` runs at most `n`
  of the group's steps at a time through a bounded pool that dispatches in declaration order. A step
  still queued when the group aborts is never dispatched at all.
- `serializeResult(result, options?)` — flattens a `Result` into a plain object that always survives
  `JSON.stringify`: errors flattened with their `cause` chains and custom fields, circular references
  as `'[Circular]'`, non-`Error` throws as `UnknownError`. The context is **excluded by default**.
- Tracing — pass `execute(input, { tracer })` to emit pipeline, step, attempt, and compensation
  spans through a minimal vendor-neutral `Tracer` / `TraceSpan` interface. Tracer calls are contained
  like hooks, and no span attribute ever carries a context or input value.
- `penstock/otel` — an optional subpath export adapting that interface to OpenTelemetry via
  `otelTracer(options?)`. `@opentelemetry/api` is an optional peer dependency, so a project that
  never imports it installs nothing extra and the core stays dependency-free.
- `Result.executionId`, `Result.pipelineName`, and `Result.durationMs`; `StepReport.idempotencyKey`.
- New exported types: `StepMeta`, `ParallelOptions`, `Tracer`, `TraceSpan`, `SerializeOptions`,
  `SerializedResult`, `SerializedStepReport`, `SerializedError`, and `OtelTracerOptions` (from
  `penstock/otel`).

### Changed

- `ctx.signal` is now **always the pipeline-level signal**: a step's own `timeout` no longer aborts
  it. Use `meta.signal`, which combines that invocation's timeout, its parallel group's abort, and
  the pipeline signal.
  **Migration:** if a step forwarded `ctx.signal` into its own async work to honour its timeout,
  change it to `meta.signal`. `ctx.signal` continues to answer "was the pipeline cancelled".

### Fixed

- Steps inside a parallel group can now observe their own timeout signal, which was not previously
  expressible: one shared `ctx.signal` could not be the per-attempt timeout signal of several
  concurrently running steps at once.

[0.4.0]: https://github.com/zaier84/penstock/releases/tag/v0.4.0
