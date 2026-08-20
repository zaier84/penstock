// Runnable against the local source. Published code imports from 'penstock'.
//
// A real deployment registers @opentelemetry/sdk-node and an OTLP exporter.
// That would mean two more dependencies here, so this file registers a tiny
// in-process TracerProvider instead: real OpenTelemetry API, real parenting,
// spans printed to the console. The SDK wiring is shown on the recipe page.
import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanStatus,
  type TimeInput,
  type Tracer as OtelTracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { pipeline } from '../../src/index.js';
import { otelTracer } from '../../src/otel/index.js';

interface Recorded {
  name: string;
  parent: string | undefined;
  attributes: Attributes;
  status: string;
  exception?: string;
}

const recorded: Recorded[] = [];
let nextId = 0;

class MiniSpan implements Span {
  readonly record: Recorded;
  private readonly ctx: SpanContext;

  constructor(name: string, parentSpanId: string | undefined) {
    nextId += 1;
    this.ctx = {
      traceId: '0'.repeat(31) + '1',
      spanId: String(nextId).padStart(16, '0'),
      traceFlags: 1,
    };
    this.record = { name, parent: parentSpanId, attributes: {}, status: 'unset' };
    recorded.push(this.record);
  }

  spanContext(): SpanContext {
    return this.ctx;
  }
  setAttribute(key: string, value: Attributes[string]): this {
    this.record.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Attributes): this {
    Object.assign(this.record.attributes, attrs);
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.record.status = status.code === SpanStatusCode.OK ? 'ok' : 'error';
    return this;
  }
  updateName(name: string): this {
    this.record.name = name;
    return this;
  }
  end(_endTime?: TimeInput): void {}
  isRecording(): boolean {
    return true;
  }
  recordException(exception: { message?: string } | string): void {
    this.record.exception =
      typeof exception === 'string' ? exception : (exception.message ?? 'unknown');
  }
}

const miniTracer: OtelTracer = {
  startSpan(name, _options, context) {
    const parent = context === undefined ? undefined : trace.getSpan(context);
    return new MiniSpan(name, parent?.spanContext().spanId);
  },
  startActiveSpan: ((name: string, ...rest: unknown[]) => {
    const fn = rest[rest.length - 1] as (span: Span) => unknown;
    return fn(new MiniSpan(name, undefined));
  }) as OtelTracer['startActiveSpan'],
};

const provider: TracerProvider = { getTracer: () => miniTracer };
trace.setGlobalTracerProvider(provider);

// ── An ordinary pipeline. Nothing here knows about OpenTelemetry. ───────────
const checkout = pipeline<{ orderId: string }>('checkout')
  .step('reserve-stock', () => ({ reservationId: 'rsv_1' }))
  .undo(() => {})
  .step('charge-card', () => {
    throw new Error('gateway declined');
  })
  .retry({ attempts: 2, delayMs: 5 })
  .idempotencyKey((ctx) => `charge:${ctx.input.orderId}`);

const result = await checkout.execute(
  { orderId: 'ord_5' },
  { tracer: otelTracer({ name: 'my-service' }) },
);

console.log(`run: ok=${result.ok}\n`);

// ── Print the span tree the exporter would have shipped ─────────────────────
const byId = new Map<string, Recorded[]>();
for (const [i, r] of recorded.entries()) {
  const key = r.parent ?? 'root';
  void i;
  byId.set(key, [...(byId.get(key) ?? []), r]);
}
const spanIdOf = (r: Recorded) =>
  String(recorded.indexOf(r) + 1).padStart(16, '0');

const print = (r: Recorded, depth: number) => {
  const pad = '  '.repeat(depth);
  console.log(`${pad}${r.name}  [${r.status}]${r.exception ? ` !${r.exception}` : ''}`);
  const keys = Object.keys(r.attributes).sort();
  for (const k of keys) console.log(`${pad}  ${k} = ${String(r.attributes[k])}`);
  for (const child of byId.get(spanIdOf(r)) ?? []) print(child, depth + 1);
};

console.log('=== spans, as the exporter would see them ===');
for (const root of byId.get('root') ?? []) print(root, 0);
