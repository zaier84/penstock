import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entry points (0.4.0 spec, section 1.9): the core, and the optional
  // OpenTelemetry adapter published as the `penstock/otel` subpath. Their
  // common root is `src`, so they emit as dist/index.* and dist/otel/index.*.
  entry: ['src/index.ts', 'src/otel/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // Never bundled: it is an optional peer dependency that only consumers who
  // import `penstock/otel` install, and the core must stay dependency-free.
  external: ['@opentelemetry/api'],
});
