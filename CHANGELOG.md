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

## [0.5.0] - 2026-08-19

### Added

- A typed pipeline builder — `pipeline<TInput>(name)` — where each step declares what it
  **produces** and the context type accumulates down the chain. A key is required from the moment
  its step has run, which removes the `ctx.reservationId!` assertion the class API forces on
  nearly every line of real code. The builder is a facade: it constructs the same `Step` and
  `Pipeline` instances, so rollback, retry, timeout, cancellation, tracing, and lifecycle events
  are inherited unchanged.
- Chained modifiers on the most recent step: `.when()`, `.undo()`, `.retry()`, `.timeout()`, and
  `.idempotencyKey()`. `.undo()` sees its own step's output as **required**; `.when()` widens that
  step's contribution to `Partial` for everything downstream. Applying a modifier twice replaces
  the earlier value, mirroring `Step.prototype.when`.
- `defineStep<TInput, TRequires>()(name, run)` — reusable, independently-typed step definitions,
  added with `.use(def)`. A definition may declare prior state it **requires**, so using it before
  the step that produces that state is a compile error rather than a runtime `undefined`. Its
  modifiers return a new definition, so one can be shared across pipelines.
- `.parallel(defs, options?)` — typed parallel groups over an array of definitions, whose
  contributions are intersected into the accumulated state.
- `.compose(name, inner, options)` — nests a pipeline as one step, contributing state by
  **returning** from `mapResult` (which may be async) rather than mutating the outer context. The
  inner pipeline may be a typed pipeline or a class-API `Pipeline`.
- `.toPipeline()` — the underlying `Pipeline`, so anything the builder does not surface stays
  reachable.
- New exported types: `TypedPipeline`, `TypedCtx`, `StepDef`, `RequiresOf`, `ProducesOf`,
  `TypedComposeOptions`, `ComposeContribution`, `InnerInputOf`, `InnerCtxOf`, `StepReturn`,
  `StateOf`, `Merge`, `Simplify`, and `UnionToIntersection`.
- `examples/typed.ts`, runnable with `npm run example:typed`.

### Deprecated

- `UseCase` — use `.compose(...)` or `Pipeline.asStep(...)` instead. Both nest one pipeline inside
  another **and** let data flow between them, which a `UseCase` cannot: it runs each pipeline on
  the same input with its own isolated context.
- `registerEngine` and `clearEngines` — use `pipeline.useEngine(engine)` instead. The global
  registry is process-wide mutable state: it leaks between tests unless every suite remembers
  `clearEngines()`, and two pipelines cannot use different engines under the same name.

Both remain fully functional and emit no runtime warnings; removal is a `1.0` decision.

### Changed

- Every `UsageError` message now states what was wrong, what was expected, and what to do, and
  names the pipeline, step, engine, or use-case involved. `Pipeline.addStep`,
  `Pipeline.addParallel`, and `UseCase.addPipeline` previously named nothing at all. No error
  **type** changed, so code branching on `UsageError` is unaffected.

### Fixed

- A step throwing a value that refuses string coercion (for example `Object.create(null)`) now
  returns `ok: false` like any other failure, instead of making `execute()` reject.

[0.5.0]: https://github.com/zaier84/penstock/releases/tag/v0.5.0

## [0.5.1] - 2026-08-20

### Changed

- `README.md` rewritten as a concise entry point: 159 lines, down from 1,197.
  It is now one runnable example, four reasons, a feature list, and links —
  every section it lost has a documented destination on the new site. Because
  the README _is_ the npmjs.com package page, this release exists mainly to put
  it there.
- **New documentation site** at
  [zaier84.github.io/penstock](https://zaier84.github.io/penstock), built with
  Astro Starlight and deployed by GitHub Actions. It carries a positioning page
  that says plainly when _not_ to use penstock, a three-page getting-started
  tutorial, five core-concept pages, fourteen feature guides, eight cookbook
  recipes, and an API reference generated from the source so it cannot drift.
  Every code sample on it was executed and shows real output. The site lives in
  `docs/` with its own `package.json` and lockfile, so the library's own
  dependency surface is untouched.

### Fixed

- TSDoc across the public API no longer refers readers to internal specification
  documents they cannot see. 144 citations of the form `(section 3.3)`,
  `(0.4.0 spec, section 1.1)`, and `PENSTOCK_0.3.0_SPEC.md section 1.2`
  appeared in the generated reference; none remain. Comments on private methods
  keep their pointers, which are useful to maintainers.
- The TSDoc for `EngineAccessor` claimed its implementation "lands in
  `engine.ts` in Phase 5". It landed in `0.1.0`; the sentence now describes
  what the type actually is.
- `otelTracer()` reported `0.5.0` as its default OpenTelemetry instrumentation
  scope version. That literal is kept in step with `package.json` by hand, and
  had been missed; it now reads `0.5.1`. It affects only the scope a backend
  attributes penstock's spans to — no span, attribute, or timing changes.
- Added `@param` documentation to the most-used public API — `pipeline()`,
  `defineStep()`, `serializeResult()`, `otelTracer()`, the `Engine` and
  `Step` constructors, `Pipeline.execute`/`addStep`/`addParallel`/`asStep`,
  and the `TypedPipeline` methods — which previously rendered as bare names and
  types with no description.

No behaviour changed in this release. Apart from that one version literal,
every edit to `src/` is a comment.

[0.5.1]: https://github.com/zaier84/penstock/releases/tag/v0.5.1
