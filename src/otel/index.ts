import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type Exception,
  type Span,
} from '@opentelemetry/api';

import type { TraceSpan, Tracer } from '../types';

/**
 * Options for {@link otelTracer} (0.4.0 spec, section 1.9). Both configure the
 * OpenTelemetry *instrumentation scope*, which is how a backend attributes
 * spans to the library that produced them.
 */
export interface OtelTracerOptions {
  /** Instrumentation scope name. Default: `'penstock'`. */
  name?: string;
  /** Instrumentation scope version. Default: the penstock version. */
  version?: string;
}

/**
 * The penstock version reported as the default instrumentation scope version.
 * A literal, not a `package.json` read: runtime code performs no I/O
 * (`BUILD_SPEC.md` section 1.10). Kept in step with `package.json`.
 */
const PENSTOCK_VERSION = '0.4.0';

/**
 * Adapts penstock's vendor-neutral {@link Tracer} onto OpenTelemetry (0.4.0
 * spec, section 1.9):
 *
 * ```ts
 * import { Pipeline } from 'penstock';
 * import { otelTracer } from 'penstock/otel';
 *
 * const result = await pipeline.execute(input, { tracer: otelTracer() });
 * ```
 *
 * This is the package's **only** code that touches `@opentelemetry/api`, and
 * it lives behind the `penstock/otel` subpath so the core keeps its
 * zero-runtime-dependency guarantee: `@opentelemetry/api` is an *optional*
 * peer dependency, installed only by users who import this module.
 *
 * Spans are started with the parent supplied through the context rather than
 * through `SpanOptions`, which is what lets an ambient active span parent a
 * root pipeline span. The adapter does not contain its own errors — the core
 * already wraps every tracer call (section 1.8), so a failing OTel SDK cannot
 * affect a pipeline either way.
 */
export function otelTracer(options: OtelTracerOptions = {}): Tracer {
  const tracer = trace.getTracer(
    options.name ?? 'penstock',
    options.version ?? PENSTOCK_VERSION,
  );
  // The private wrapper-to-OTel-span mapping that makes parenting work. A
  // WeakMap keyed by the wrapper object: no string keys, so nothing here is a
  // prototype-pollution surface, and a span is collectable as soon as the
  // caller drops it.
  const spans = new WeakMap<TraceSpan, Span>();

  return {
    startSpan(name: string, parent?: TraceSpan): TraceSpan {
      const parentSpan = parent === undefined ? undefined : spans.get(parent);
      const context =
        parentSpan === undefined
          ? otelContext.active()
          : trace.setSpan(otelContext.active(), parentSpan);
      const span = tracer.startSpan(name, undefined, context);
      const wrapper: TraceSpan = {
        setAttribute(key, value) {
          span.setAttribute(key, value);
        },
        recordException(error) {
          span.recordException(toException(error));
        },
        setStatus(status, message) {
          if (status === 'ok') {
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          span.setStatus(
            message === undefined
              ? { code: SpanStatusCode.ERROR }
              : { code: SpanStatusCode.ERROR, message },
          );
        },
        end() {
          span.end();
        },
      };
      spans.set(wrapper, span);
      return wrapper;
    },
  };
}

/**
 * Renders a thrown value as something `Span.recordException` accepts. penstock
 * hands over whatever a step threw, which need not be an `Error` at all.
 * Objects are described rather than coerced: a null-prototype object throws on
 * `String()`, and a tracer call must never be what breaks a run.
 */
function toException(error: unknown): Exception {
  if (error instanceof Error || typeof error === 'string') {
    return error;
  }
  if (error !== null && typeof error === 'object') {
    return { message: 'non-Error value thrown' };
  }
  // Primitives — including `null`, `undefined` and symbols — coerce safely.
  return { message: String(error) };
}
