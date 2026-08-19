import {
  SpanStatusCode,
  trace,
  type Context,
  type Exception,
  type Span,
  type SpanOptions,
  type SpanStatus,
  type Tracer as OtelTracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { otelTracer } from '../src/otel/index';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { TraceSpan } from '../src/types';

/** One `startSpan` call and everything done to the span it returned. */
interface SpanRecord {
  name: string;
  options: SpanOptions | undefined;
  context: Context | undefined;
  span: Span;
  attributes: [string, unknown][];
  exceptions: Exception[];
  statuses: SpanStatus[];
  ends: number;
}

interface Harness {
  provider: TracerProvider;
  scopes: { name: string; version: string | undefined }[];
  spans: SpanRecord[];
}

/**
 * A hand-built stub `TracerProvider` — the alternative the spec offers to an
 * SDK in-memory exporter (section 1.9), and the one that keeps
 * `@opentelemetry/api` the only OpenTelemetry package this repo depends on.
 */
function stubProvider(): Harness {
  const scopes: { name: string; version: string | undefined }[] = [];
  const spans: SpanRecord[] = [];

  const makeSpan = (record: SpanRecord): Span => {
    const span = {
      spanContext: () => ({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 1,
      }),
      setAttribute(key: string, value: unknown) {
        record.attributes.push([key, value]);
        return span;
      },
      setAttributes() {
        return span;
      },
      addEvent() {
        return span;
      },
      addLink() {
        return span;
      },
      addLinks() {
        return span;
      },
      setStatus(status: SpanStatus) {
        record.statuses.push(status);
        return span;
      },
      updateName() {
        return span;
      },
      end() {
        record.ends += 1;
      },
      isRecording: () => true,
      recordException(exception: Exception) {
        record.exceptions.push(exception);
      },
    };
    return span as unknown as Span;
  };

  const tracer = {
    startSpan(name: string, options?: SpanOptions, context?: Context): Span {
      // The record is created first and handed to the span by reference, so
      // every later mutation (notably the `ends` counter) lands on the very
      // object the assertions read back.
      const record: SpanRecord = {
        name,
        options,
        context,
        span: undefined as unknown as Span,
        attributes: [],
        exceptions: [],
        statuses: [],
        ends: 0,
      };
      record.span = makeSpan(record);
      spans.push(record);
      return record.span;
    },
    startActiveSpan(): never {
      throw new Error('the adapter never calls startActiveSpan');
    },
  } as unknown as OtelTracer;

  const provider: TracerProvider = {
    getTracer(name: string, version?: string): OtelTracer {
      scopes.push({ name, version });
      return tracer;
    },
  };

  return { provider, scopes, spans };
}

/** The stub records `attributes` by push, so later writes win — same as a real span. */
function attributesOf(record: SpanRecord): Map<string, unknown> {
  return new Map(record.attributes);
}

function record(harness: Harness, name: string): SpanRecord {
  const matches = harness.spans.filter((span) => span.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('penstock/otel adapter (0.4.0 section 1.9)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = stubProvider();
    expect(trace.setGlobalTracerProvider(harness.provider)).toBe(true);
  });

  afterEach(() => {
    trace.disable();
  });

  describe('shape and instrumentation scope', () => {
    it('returns a Tracer satisfying the core interface', () => {
      const tracer = otelTracer();
      expect(typeof tracer.startSpan).toBe('function');

      const span: TraceSpan = tracer.startSpan('s');
      expect(typeof span.setAttribute).toBe('function');
      expect(typeof span.recordException).toBe('function');
      expect(typeof span.setStatus).toBe('function');
      expect(typeof span.end).toBe('function');
    });

    it('defaults the instrumentation scope to penstock and the package version', () => {
      otelTracer().startSpan('s');
      expect(harness.scopes).toEqual([{ name: 'penstock', version: '0.5.0' }]);
    });

    it('honours a custom scope name and version', () => {
      otelTracer({ name: 'my-app', version: '9.9.9' }).startSpan('s');
      expect(harness.scopes).toEqual([{ name: 'my-app', version: '9.9.9' }]);
    });

    it('honours a custom name while keeping the default version', () => {
      otelTracer({ name: 'my-app' }).startSpan('s');
      expect(harness.scopes).toEqual([{ name: 'my-app', version: '0.5.0' }]);
    });
  });

  describe('call mapping', () => {
    it('forwards setAttribute for strings, numbers and booleans', () => {
      const span = otelTracer().startSpan('s');
      span.setAttribute('penstock.step.name', 'charge');
      span.setAttribute('penstock.step.attempts', 3);
      span.setAttribute('penstock.pipeline.ok', true);

      expect(record(harness, 's').attributes).toEqual([
        ['penstock.step.name', 'charge'],
        ['penstock.step.attempts', 3],
        ['penstock.pipeline.ok', true],
      ]);
    });

    it('maps an ok status onto SpanStatusCode.OK', () => {
      otelTracer().startSpan('s').setStatus('ok');
      expect(record(harness, 's').statuses).toEqual([
        { code: SpanStatusCode.OK },
      ]);
    });

    it('maps an error status with a message onto SpanStatusCode.ERROR', () => {
      otelTracer().startSpan('s').setStatus('error', 'Step "a" failed');
      expect(record(harness, 's').statuses).toEqual([
        { code: SpanStatusCode.ERROR, message: 'Step "a" failed' },
      ]);
    });

    it('omits the message when an error status carries none', () => {
      otelTracer().startSpan('s').setStatus('error');
      expect(record(harness, 's').statuses).toEqual([
        { code: SpanStatusCode.ERROR },
      ]);
    });

    it('forwards an Error to recordException unchanged', () => {
      const error = new Error('boom');
      otelTracer().startSpan('s').recordException(error);
      expect(record(harness, 's').exceptions).toEqual([error]);
    });

    it('forwards a thrown string as-is', () => {
      otelTracer().startSpan('s').recordException('boom');
      expect(record(harness, 's').exceptions).toEqual(['boom']);
    });

    it('renders thrown primitives as a message-bearing exception', () => {
      const span = otelTracer().startSpan('s');
      span.recordException(42);
      span.recordException(null);
      span.recordException(undefined);
      expect(record(harness, 's').exceptions).toEqual([
        { message: '42' },
        { message: 'null' },
        { message: 'undefined' },
      ]);
    });

    it('renders a thrown object without coercing it', () => {
      const span = otelTracer().startSpan('s');
      // A null-prototype object throws on String(); the adapter must not try.
      span.recordException(Object.create(null));
      span.recordException({ code: 'E_NOPE' });
      expect(record(harness, 's').exceptions).toEqual([
        { message: 'non-Error value thrown' },
        { message: 'non-Error value thrown' },
      ]);
    });

    it('forwards end', () => {
      otelTracer().startSpan('s').end();
      expect(record(harness, 's').ends).toBe(1);
    });
  });

  describe('parenting', () => {
    it('starts a root span with no active span in its context', () => {
      otelTracer().startSpan('root');
      const { context } = record(harness, 'root');
      expect(context).toBeDefined();
      expect(trace.getSpan(context!)).toBeUndefined();
    });

    it('sets the parent span on the context of a child span', () => {
      const tracer = otelTracer();
      const parent = tracer.startSpan('parent');
      tracer.startSpan('child', parent);

      const child = record(harness, 'child');
      expect(trace.getSpan(child.context!)).toBe(
        record(harness, 'parent').span,
      );
    });

    it('always passes undefined SpanOptions, so the context decides the parent', () => {
      otelTracer().startSpan('root');
      expect(record(harness, 'root').options).toBeUndefined();
    });

    it('treats a foreign TraceSpan as no parent rather than throwing', () => {
      const foreign: TraceSpan = {
        setAttribute() {},
        recordException() {},
        setStatus() {},
        end() {},
      };

      otelTracer().startSpan('orphan', foreign);

      expect(trace.getSpan(record(harness, 'orphan').context!)).toBeUndefined();
    });

    it('keeps each otelTracer() call is own span mapping', () => {
      const first = otelTracer();
      const parent = first.startSpan('parent');
      // A different adapter instance never saw this wrapper, so it cannot
      // resolve it — proof the mapping is private per tracer, not global.
      otelTracer().startSpan('child', parent);

      expect(trace.getSpan(record(harness, 'child').context!)).toBeUndefined();
    });
  });

  describe('end to end through a real pipeline', () => {
    it('emits the penstock span tree onto the OpenTelemetry tracer', async () => {
      const result = await new Pipeline<BaseContext>('checkout')
        .addStep(
          new Step<BaseContext>('reserve', { run: () => {}, undo: () => {} }),
        )
        .addStep(
          new Step<BaseContext>('charge', () => {
            throw new Error('declined');
          }),
        )
        .execute({}, { tracer: otelTracer() });

      expect(result.ok).toBe(false);
      expect(harness.spans.map((span) => span.name)).toEqual([
        'penstock.pipeline checkout',
        'penstock.step reserve',
        'penstock.step charge',
        'penstock.undo reserve',
      ]);

      const pipeline = record(harness, 'penstock.pipeline checkout');
      expect(attributesOf(pipeline).get('penstock.pipeline.name')).toBe(
        'checkout',
      );
      expect(attributesOf(pipeline).get('penstock.pipeline.ok')).toBe(false);
      expect(pipeline.statuses).toEqual([
        { code: SpanStatusCode.ERROR, message: 'Step "charge" failed' },
      ]);

      // Every step and compensation span hangs off the pipeline span.
      for (const name of [
        'penstock.step reserve',
        'penstock.step charge',
        'penstock.undo reserve',
      ]) {
        expect(trace.getSpan(record(harness, name).context!)).toBe(
          pipeline.span,
        );
      }

      const charge = record(harness, 'penstock.step charge');
      expect(charge.exceptions).toEqual([result.error]);
      expect(charge.statuses).toEqual([
        { code: SpanStatusCode.ERROR, message: 'Step "charge" failed' },
      ]);
      // Nothing is left open.
      expect(harness.spans.every((span) => span.ends === 1)).toBe(true);
    });

    it('nests attempt spans under their step span', async () => {
      let calls = 0;
      await new Pipeline<BaseContext>('p')
        .addStep(
          new Step<BaseContext>('flaky', {
            run: () => {
              calls += 1;
              if (calls < 2) throw new Error('again');
            },
            retry: { attempts: 2 },
          }),
        )
        .execute({}, { tracer: otelTracer() });

      const step = record(harness, 'penstock.step flaky');
      for (const name of [
        'penstock.attempt flaky#1',
        'penstock.attempt flaky#2',
      ]) {
        expect(trace.getSpan(record(harness, name).context!)).toBe(step.span);
      }
    });
  });
});
