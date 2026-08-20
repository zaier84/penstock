---
title: Security model
description: What penstock guarantees about dependencies, dynamic code execution, I/O, prototype pollution, and what it will never log.
---

penstock is a library that sits in the middle of operations handling payment
details, personal data, and credentials. The design rules below are treated as
invariants rather than preferences, and most of them are enforced by tests in
the repository rather than by review alone.

## Zero runtime dependencies

The core has **no runtime dependencies at all**, so installing penstock adds no
transitive dependency tree to your project — the single largest supply-chain
risk for a library is simply absent. You can confirm it by reading the
`dependencies` field of the published `package.json`, which is `{}`.

The optional `penstock/otel` adapter requires `@opentelemetry/api`, which you
install only if you use it. It is declared as an *optional* peer dependency, so
npm will not pull it in on your behalf.

Releases are published from CI through npm's trusted publishing (OIDC), so no
long-lived npm token exists to be stolen, and every release after `0.1.0`
carries build provenance.

## No dynamic code execution

No `eval`, no `new Function`, no `vm`, and no dynamic `import()` or `require()`
of a specifier derived from user input. The library only ever invokes functions
you explicitly passed to it — a step's `run`, `when`, or `undo`, or an engine
method.

## No I/O, no telemetry, no phone-home

Runtime code performs **no network requests, no filesystem access, no
environment scanning, and no analytics**. There is no data-exfiltration surface.

Tracing is not an exception to this. penstock emits spans only to a `Tracer`
*you* supply, and it never opens a connection itself; where those spans go is
entirely determined by the code you wired up.

## Prototype-pollution safe

Every name-keyed lookup — the engine registry, per-pipeline engines, the
step-name set, the `EngineAccessor` — is backed by a `Map`, a `Set`, or a
null-prototype object, never a plain object indexed by a user-supplied key.

The names `__proto__`, `prototype`, and `constructor` are **rejected** as step,
pipeline, engine, and use-case names with a `UsageError`. The same guard covers
the typed builder's merge path: a step that returns an object with one of those
keys throws rather than merging it, and the write itself uses
`Object.defineProperty` rather than assignment, so a key named `__proto__`
could only ever become an own data property.

## It never logs your data

The library logs step and pipeline **names**, statuses, durations, and error
message/type. It never passes `ctx.input` or any context value to a logger.
Your context may hold whatever it needs to; penstock will not surface it.

The same rule governs [trace attributes](../guides/tracing/), which carry only names, ids, statuses,
counts, durations, and the idempotency key. The one caveat is the key itself:
it is either library-generated or chosen by you, so **an idempotency key you
derive from sensitive data will appear in your tracing backend**. Derive keys
from identifiers, not from card numbers or personal details.

[`serializeResult()`](../guides/serialization/) follows the rule too — it **excludes `result.context` by
default**, because a serialized `Result` is destined for a log aggregator.
`{ includeContext: true }` opts in, and means opting into whatever the context
holds.

## Errors carry names, not payloads

Error messages reference step, pipeline, and engine names and the *types* of
values involved — never the values themselves. A step that returns something
unmergeable is told it returned "an array" or "a non-plain object", not what was
in it.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on the repository, or the address
in [`SECURITY.md`](https://github.com/zaier84/penstock/blob/main/SECURITY.md).
Please do not open a public issue for a vulnerability. Reports about the
library's own runtime behaviour — prototype pollution, unsafe name handling, a
log line that leaks context — are especially welcome.
