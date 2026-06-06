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
