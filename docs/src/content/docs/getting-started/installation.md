---
title: Installation
description: Installing penstock, supported Node versions, ESM and CommonJS, TypeScript setup, and the exact dependency claim.
sidebar:
  order: 2
---

```sh
npm install penstock
```

That is the whole installation. There is nothing to configure, no server to
run, and no peer dependency to add unless you want the OpenTelemetry adapter.

## Requirements

**Node `>=20`**, with **22 or newer recommended**. Node 20 is past its
end-of-life but still widely deployed, so it is supported rather than blocked;
CI runs the full suite on 20, 22, and 24.

penstock uses only Node built-ins that have been stable since 20:
`AbortSignal.any()`, `AbortSignal.timeout()`, `crypto.randomUUID()`,
`performance.now()`, and `setTimeout` from `node:timers/promises`.

## ESM and CommonJS

Both are shipped from the same package, with correct type declarations for
each.

```ts
// ESM
import { pipeline } from 'penstock';
```

```js
// CommonJS
const { pipeline } = require('penstock');
```

The `exports` map is validated on every CI run by
[`publint`](https://publint.dev) and
[`@arethetypeswrong/cli`](https://arethetypeswrong.github.io), so `import`,
`require`, `node10`, `node16`, and bundler resolution are all verified rather
than assumed.

## TypeScript

Types are bundled — there is no `@types/penstock`. penstock is written in
TypeScript under `strict: true`, and the typed builder needs `strict` (or at
least `strictNullChecks`) on your side to be worth anything: without it, the
accumulated context types still compute, but the compiler will not hold you to
them.

No other compiler options are required. `moduleResolution` of `bundler`,
`node16`, or `nodenext` all resolve the package correctly.

## Dependencies

**Zero runtime dependencies.** The optional `penstock/otel` adapter requires
`@opentelemetry/api`, which you install only if you use it.

It is declared as an *optional* peer dependency, so npm will not install it for
you. A project that never imports `penstock/otel` gets nothing extra in
`node_modules`, and the core keeps no transitive dependency tree at all.

```sh
# Only if you want the OpenTelemetry adapter
npm install @opentelemetry/api
```

## Next

[Your first pipeline](../your-first-pipeline/) — build one from scratch, one
step at a time, with the printed `Result` at every stage.
