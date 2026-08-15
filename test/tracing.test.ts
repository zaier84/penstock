import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import type { Logger } from '../src/logger';
import { noopLogger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import {
  createTracing,
  recordPipelineOutcome,
  recordStepOutcome,
} from '../src/tracing';
import type { Result, TraceSpan, Tracer } from '../src/types';

interface Ctx extends BaseContext {
  token?: string;
  marker?: string;
}

/** One span as the fake tracer saw it, including how many times it was ended. */
interface RecordedSpan {
  name: string;
  parent: RecordedSpan | undefined;
  attributes: Map<string, string | number | boolean>;
  exceptions: unknown[];
  statuses: { status: 'ok' | 'error'; message?: string }[];
  ends: number;
}

/**
 * An in-memory {@link Tracer} that records everything penstock does to it. The
 * wrapper-to-record mapping is a `WeakMap`, mirroring how the real OTel adapter
 * resolves a parent span, so parenting is exercised the same way.
 */
function fakeTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const records = new WeakMap<TraceSpan, RecordedSpan>();
  const tracer: Tracer = {
    startSpan(name, parent) {
      const record: RecordedSpan = {
        name,
        parent: parent === undefined ? undefined : records.get(parent),
        attributes: new Map(),
        exceptions: [],
        statuses: [],
        ends: 0,
      };
      spans.push(record);
      const span: TraceSpan = {
        setAttribute(key, value) {
          record.attributes.set(key, value);
        },
        recordException(error) {
          record.exceptions.push(error);
        },
        setStatus(status, message) {
          record.statuses.push(
            message === undefined ? { status } : { status, message },
          );
        },
        end() {
          record.ends += 1;
        },
      };
      records.set(span, record);
      return span;
    },
  };
  return { tracer, spans };
}

/** A tracer whose every method throws, to prove containment (section 1.8). */
function hostileTracer(): Tracer {
  return {
    startSpan() {
      return {
        setAttribute() {
          throw new Error('setAttribute exploded');
        },
        recordException() {
          throw new Error('recordException exploded');
        },
        setStatus() {
          throw new Error('setStatus exploded');
        },
        end() {
          throw new Error('end exploded');
        },
      };
    },
  };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** All spans with the given name. */
function named(spans: RecordedSpan[], name: string): RecordedSpan[] {
  return spans.filter((span) => span.name === name);
}

/** The single span with the given name; fails the test if there is not exactly one. */
function only(spans: RecordedSpan[], name: string): RecordedSpan {
  const matches = named(spans, name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/**
 * The invariant the spec demands on every path (section 1.8): no started span
 * is ever left open, and none is ended twice.
 */
function expectEverySpanEndedOnce(spans: RecordedSpan[]): void {
  expect(spans.length).toBeGreaterThan(0);
  const ended = spans.filter((span) => span.ends === 1);
  expect(ended.length).toBe(spans.length);
  expect(
    spans.filter((span) => span.ends !== 1).map((span) => span.name),
  ).toEqual([]);
}

describe('tracing (0.4.0 section 1.8)', () => {
  describe('pipeline span', () => {
    it('starts exactly one pipeline span per execution, with no parent', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('checkout')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { tracer });

      const pipeline = only(spans, 'penstock.pipeline checkout');
      expect(pipeline.parent).toBeUndefined();
    });

    it('carries the documented start and completion attributes', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('checkout')
        .addStep(new Step<Ctx>('a', () => {}))
        .addParallel([
          new Step<Ctx>('b', () => {}),
          new Step<Ctx>('c', () => {}),
        ])
        .execute({}, { tracer });

      const attrs = only(spans, 'penstock.pipeline checkout').attributes;
      expect(attrs.get('penstock.pipeline.name')).toBe('checkout');
      expect(attrs.get('penstock.execution.id')).toBe(result.executionId);
      // Steps, not entries: the parallel group contributes two.
      expect(attrs.get('penstock.pipeline.step_count')).toBe(3);
      expect(attrs.get('penstock.pipeline.ok')).toBe(true);
      expect(attrs.get('penstock.pipeline.aborted')).toBe(false);
      expect(attrs.get('penstock.pipeline.duration_ms')).toBe(
        result.durationMs,
      );
      expect(attrs.get('penstock.pipeline.rollback_error_count')).toBe(0);
    });

    it('reports a failed run as not ok, not aborted, and status error', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      const pipeline = only(spans, 'penstock.pipeline p');
      expect(pipeline.attributes.get('penstock.pipeline.ok')).toBe(false);
      expect(pipeline.attributes.get('penstock.pipeline.aborted')).toBe(false);
      expect(pipeline.exceptions).toEqual([result.error]);
      expect(pipeline.statuses).toEqual([
        { status: 'error', message: 'Step "boom" failed' },
      ]);
    });

    it('reports a cancelled run as aborted', async () => {
      const { tracer, spans } = fakeTracer();
      const controller = new AbortController();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', () => {
            controller.abort(new Error('stop'));
          }),
        )
        .addStep(new Step<Ctx>('b', () => {}))
        .execute({}, { tracer, signal: controller.signal });

      const pipeline = only(spans, 'penstock.pipeline p');
      expect(pipeline.attributes.get('penstock.pipeline.ok')).toBe(false);
      expect(pipeline.attributes.get('penstock.pipeline.aborted')).toBe(true);
    });

    it('counts rollback errors on the pipeline span', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              throw new Error('undo failed');
            },
          }),
        )
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      expect(
        only(spans, 'penstock.pipeline p').attributes.get(
          'penstock.pipeline.rollback_error_count',
        ),
      ).toBe(1);
    });

    it('parents the pipeline span to an explicit parentSpan', async () => {
      const { tracer, spans } = fakeTracer();
      const outer = tracer.startSpan('caller');

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { tracer, parentSpan: outer });

      expect(only(spans, 'penstock.pipeline p').parent).toBe(
        only(spans, 'caller'),
      );
    });

    it('emits nothing at all when no tracer is supplied', async () => {
      const { spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({});

      expect(result.ok).toBe(true);
      expect(spans).toHaveLength(0);
    });
  });

  describe('step spans', () => {
    it('starts one step span per step, parented to the pipeline span', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(new Step<Ctx>('b', () => {}))
        .execute({}, { tracer });

      const pipeline = only(spans, 'penstock.pipeline p');
      expect(only(spans, 'penstock.step a').parent).toBe(pipeline);
      expect(only(spans, 'penstock.step b').parent).toBe(pipeline);
    });

    it('carries the step name, idempotency key, status, attempts and duration', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('charge', { run: () => {}, idempotencyKey: 'key-1' }),
        )
        .execute({}, { tracer });

      const attrs = only(spans, 'penstock.step charge').attributes;
      expect(attrs.get('penstock.step.name')).toBe('charge');
      expect(attrs.get('penstock.step.idempotency_key')).toBe('key-1');
      expect(attrs.get('penstock.step.status')).toBe('completed');
      expect(attrs.get('penstock.step.attempts')).toBe(1);
      expect(attrs.get('penstock.step.duration_ms')).toBe(
        result.steps[0]!.durationMs,
      );
      expect(attrs.has('penstock.step.timed_out')).toBe(false);
      expect(attrs.has('penstock.step.skip_reason')).toBe(false);
    });

    it('records the default idempotency key when none is configured', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { tracer });

      expect(
        only(spans, 'penstock.step a').attributes.get(
          'penstock.step.idempotency_key',
        ),
      ).toBe(`${result.executionId}:a`);
    });

    it('gives a guard-skipped step a span carrying its skip reason, status ok', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, when: () => false }))
        .execute({}, { tracer });

      const span = only(spans, 'penstock.step a');
      expect(span.attributes.get('penstock.step.status')).toBe('skipped');
      expect(span.attributes.get('penstock.step.skip_reason')).toBe(
        'guard returned false',
      );
      expect(span.statuses).toEqual([{ status: 'ok' }]);
      // A step that never ran has no key to report.
      expect(span.attributes.has('penstock.step.idempotency_key')).toBe(false);
    });

    it('gives steps never reached by a cancelled run a span with skip reason "cancelled"', async () => {
      const { tracer, spans } = fakeTracer();
      const controller = new AbortController();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', () => {
            controller.abort(new Error('stop'));
          }),
        )
        .addStep(new Step<Ctx>('b', () => {}))
        .execute({}, { tracer, signal: controller.signal });

      const span = only(spans, 'penstock.step b');
      expect(span.attributes.get('penstock.step.status')).toBe('skipped');
      expect(span.attributes.get('penstock.step.skip_reason')).toBe(
        'cancelled',
      );
      expect(span.statuses).toEqual([{ status: 'ok' }]);
    });

    it('marks a timed-out step with penstock.step.timed_out', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('slow', {
            run: () => new Promise((resolve) => setTimeout(resolve, 60)),
            timeout: 5,
          }),
        )
        .execute({}, { tracer });

      expect(
        only(spans, 'penstock.step slow').attributes.get(
          'penstock.step.timed_out',
        ),
      ).toBe(true);
    });

    it('records the exception and an error status on a failed step', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      const span = only(spans, 'penstock.step boom');
      expect(span.attributes.get('penstock.step.status')).toBe('failed');
      expect(span.exceptions).toEqual([result.steps[0]!.error]);
      expect(span.statuses).toEqual([
        { status: 'error', message: 'Step "boom" failed' },
      ]);
    });

    it('gives every step of a parallel group its own span under the pipeline span', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', () => {}),
          new Step<Ctx>('b', () => {}),
          new Step<Ctx>('c', { run: () => {}, when: () => false }),
        ])
        .execute({}, { tracer });

      const pipeline = only(spans, 'penstock.pipeline p');
      for (const name of ['a', 'b', 'c']) {
        expect(only(spans, `penstock.step ${name}`).parent).toBe(pipeline);
      }
    });

    it('gives a step queued behind a concurrency limit — and never dispatched — its own span', async () => {
      const { tracer, spans } = fakeTracer();
      const cRun = vi.fn();

      await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('a', () => {
              throw new Error('nope');
            }),
            new Step<Ctx>('b', () => {}),
            new Step<Ctx>('c', cRun),
          ],
          { concurrency: 1 },
        )
        .execute({}, { tracer });

      expect(cRun).not.toHaveBeenCalled();
      const span = only(spans, 'penstock.step c');
      expect(span.attributes.get('penstock.step.skip_reason')).toBe(
        'cancelled (parallel peer failed)',
      );
      expect(span.statuses).toEqual([{ status: 'ok' }]);
    });
  });

  describe('attempt spans', () => {
    it('emits none when the step has no retry policy', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { tracer });

      expect(
        spans.filter((s) => s.name.startsWith('penstock.attempt')),
      ).toEqual([]);
    });

    it('emits none when maxAttempts is exactly 1', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, retry: { attempts: 1 } }))
        .execute({}, { tracer });

      expect(
        spans.filter((s) => s.name.startsWith('penstock.attempt')),
      ).toEqual([]);
    });

    it('emits one span per attempt, parented to the step span, when maxAttempts > 1', async () => {
      const { tracer, spans } = fakeTracer();
      let calls = 0;

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('flaky', {
            run: () => {
              calls += 1;
              if (calls < 3) throw new Error(`attempt-${calls}`);
            },
            retry: { attempts: 3 },
          }),
        )
        .execute({}, { tracer });

      const step = only(spans, 'penstock.step flaky');
      const attempts = spans.filter((s) =>
        s.name.startsWith('penstock.attempt'),
      );
      expect(attempts.map((s) => s.name)).toEqual([
        'penstock.attempt flaky#1',
        'penstock.attempt flaky#2',
        'penstock.attempt flaky#3',
      ]);
      expect(attempts.every((s) => s.parent === step)).toBe(true);
    });

    it('marks failed attempts error and the succeeding attempt ok', async () => {
      const { tracer, spans } = fakeTracer();
      let calls = 0;

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('flaky', {
            run: () => {
              calls += 1;
              if (calls < 2) throw new Error('attempt-1 failed');
            },
            retry: { attempts: 2 },
          }),
        )
        .execute({}, { tracer });

      const first = only(spans, 'penstock.attempt flaky#1');
      expect(first.statuses).toEqual([
        { status: 'error', message: 'attempt-1 failed' },
      ]);
      expect(first.exceptions).toHaveLength(1);
      expect(only(spans, 'penstock.attempt flaky#2').statuses).toEqual([
        { status: 'ok' },
      ]);
    });

    it('emits attempt spans for a retried step inside a parallel group', async () => {
      const { tracer, spans } = fakeTracer();
      let calls = 0;

      await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', {
            run: () => {
              calls += 1;
              if (calls < 2) throw new Error('again');
            },
            retry: { attempts: 2 },
          }),
          new Step<Ctx>('b', () => {}),
        ])
        .execute({}, { tracer });

      expect(named(spans, 'penstock.attempt a#1')).toHaveLength(1);
      expect(only(spans, 'penstock.attempt a#2').parent).toBe(
        only(spans, 'penstock.step a'),
      );
    });
  });

  describe('compensation spans', () => {
    it('emits one undo span per compensation, parented to the pipeline span', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, undo: () => {} }))
        .addStep(new Step<Ctx>('b', { run: () => {}, undo: () => {} }))
        .addStep(
          new Step<Ctx>('c', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      const pipeline = only(spans, 'penstock.pipeline p');
      const undos = spans.filter((s) => s.name.startsWith('penstock.undo'));
      // Reverse declaration order, exactly like the rollback walk (section 1.7).
      expect(undos.map((s) => s.name)).toEqual([
        'penstock.undo b',
        'penstock.undo a',
      ]);
      expect(undos.every((s) => s.parent === pipeline)).toBe(true);
      expect(undos[0]!.attributes.get('penstock.step.name')).toBe('b');
      expect(undos[0]!.attributes.get('penstock.step.status')).toBe(
        'rolled-back',
      );
      expect(undos[0]!.statuses).toEqual([{ status: 'ok' }]);
    });

    it('emits no undo span for a completed step that declares no undo', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      expect(spans.filter((s) => s.name.startsWith('penstock.undo'))).toEqual(
        [],
      );
    });

    it('records the exception and an error status on a failed compensation', async () => {
      const { tracer, spans } = fakeTracer();
      const undoError = new Error('undo failed');

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              throw undoError;
            },
          }),
        )
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      const span = only(spans, 'penstock.undo a');
      expect(span.attributes.get('penstock.step.status')).toBe(
        'rollback-failed',
      );
      expect(span.exceptions).toEqual([undoError]);
      expect(span.statuses).toEqual([
        { status: 'error', message: 'undo failed' },
      ]);
      expect(result.rollbackErrors).toEqual([undoError]);
    });
  });

  describe('span lifetime — every started span is ended, on every path', () => {
    it('success', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(new Step<Ctx>('b', { run: () => {}, retry: { attempts: 2 } }))
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('step failure', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(
          new Step<Ctx>('b', {
            run: () => {
              throw new Error('nope');
            },
            retry: { attempts: 2 },
          }),
        )
        .addStep(new Step<Ctx>('c', () => {}))
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('rollback', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, undo: () => {} }))
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('rollback failure', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              throw new Error('undo failed');
            },
          }),
        )
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('cancellation', async () => {
      const { tracer, spans } = fakeTracer();
      const controller = new AbortController();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {
              controller.abort(new Error('stop'));
            },
            undo: () => {},
          }),
        )
        .addStep(new Step<Ctx>('b', () => {}))
        .addParallel([
          new Step<Ctx>('c', () => {}),
          new Step<Ctx>('d', () => {}),
        ])
        .execute({}, { tracer, signal: controller.signal });

      expectEverySpanEndedOnce(spans);
    });

    it('guard throw', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(
          new Step<Ctx>('b', {
            run: () => {},
            when: () => {
              throw new Error('guard exploded');
            },
          }),
        )
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('guard throw inside a parallel group', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', { run: () => {}, when: () => false }),
          new Step<Ctx>('b', {
            run: () => {},
            when: () => {
              throw new Error('guard exploded');
            },
          }),
          new Step<Ctx>('c', () => {}),
        ])
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('parallel-group failure', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', () => {
            throw new Error('nope');
          }),
          new Step<Ctx>('b', { run: () => {}, undo: () => {} }),
          new Step<Ctx>('c', () => {
            throw new Error('also nope');
          }),
        ])
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('bounded parallel group whose first step fails', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('a', () => {
              throw new Error('nope');
            }),
            new Step<Ctx>('b', () => {}),
            new Step<Ctx>('c', () => {}),
            new Step<Ctx>('d', () => {}),
          ],
          { concurrency: 2 },
        )
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('a throwing idempotency key function', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            idempotencyKey: () => {
              throw new Error('key exploded');
            },
          }),
        )
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('a throwing idempotency key function inside a parallel group', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', {
            run: () => {},
            idempotencyKey: () => {
              throw new Error('key exploded');
            },
          }),
          new Step<Ctx>('b', () => {}),
        ])
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('asStep inner failure', async () => {
      const { tracer, spans } = fakeTracer();
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {
          throw new Error('inner nope');
        }),
      );

      await new Pipeline<Ctx>('outer')
        .addStep(inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }))
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });

    it('throwOnError, which throws out of execute', async () => {
      const { tracer, spans } = fakeTracer();

      await expect(
        new Pipeline<Ctx>('p')
          .addStep(new Step<Ctx>('a', { run: () => {}, undo: () => {} }))
          .addStep(
            new Step<Ctx>('b', () => {
              throw new Error('nope');
            }),
          )
          .execute({}, { tracer, throwOnError: true }),
      ).rejects.toThrow('Pipeline "p" failed');

      expectEverySpanEndedOnce(spans);
    });

    it('a lifecycle callback that throws', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .onSettled(() => {
          throw new Error('callback exploded');
        })
        .execute({}, { tracer });

      expectEverySpanEndedOnce(spans);
    });
  });

  describe('attribute hygiene (extends section 1.10)', () => {
    const SECRET = 'sk_live_SENTINEL_MUST_NOT_BE_TRACED';

    it('never puts a context or input value in any span attribute', async () => {
      const { tracer, spans } = fakeTracer();
      const controller = new AbortController();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('reads-input', {
            run: (ctx) => {
              ctx.token = `${(ctx.input as { card: string }).card}-derived`;
            },
            undo: () => {},
          }),
        )
        .addStep(
          new Step<Ctx>('skipped-by-guard', {
            run: () => {},
            when: () => false,
          }),
        )
        .addStep(
          new Step<Ctx>('retried', {
            run: () => {
              throw new Error('generic failure');
            },
            retry: { attempts: 2 },
          }),
        )
        .addStep(new Step<Ctx>('never-reached', () => {}))
        .execute({ card: SECRET }, { tracer, signal: controller.signal });

      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.name).not.toContain(SECRET);
        for (const [key, value] of span.attributes) {
          expect(key).not.toContain(SECRET);
          expect(String(value)).not.toContain(SECRET);
        }
        for (const status of span.statuses) {
          expect(status.message ?? '').not.toContain(SECRET);
        }
      }
    });

    it('records only the documented penstock.* attribute keys', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {},
            timeout: 1000,
            retry: { attempts: 2 },
          }),
        )
        .addStep(new Step<Ctx>('b', { run: () => {}, when: () => false }))
        .addStep(
          new Step<Ctx>('c', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer });

      const allowed = new Set([
        'penstock.pipeline.name',
        'penstock.execution.id',
        'penstock.pipeline.step_count',
        'penstock.pipeline.ok',
        'penstock.pipeline.aborted',
        'penstock.pipeline.duration_ms',
        'penstock.pipeline.rollback_error_count',
        'penstock.step.name',
        'penstock.step.idempotency_key',
        'penstock.step.status',
        'penstock.step.attempts',
        'penstock.step.duration_ms',
        'penstock.step.timed_out',
        'penstock.step.skip_reason',
      ]);
      for (const span of spans) {
        for (const key of span.attributes.keys()) {
          expect(allowed.has(key)).toBe(true);
        }
      }
    });

    it('does surface a user-chosen idempotency key, which is the documented trade-off', async () => {
      const { tracer, spans } = fakeTracer();

      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: (ctx) =>
              `order-${(ctx.input as { id: string }).id}`,
          }),
        )
        .execute({ id: '42' }, { tracer });

      expect(
        only(spans, 'penstock.step charge').attributes.get(
          'penstock.step.idempotency_key',
        ),
      ).toBe('order-42');
    });
  });

  describe('containment — a broken tracer never changes the Result', () => {
    it('contains a tracer whose startSpan throws', async () => {
      const logger = fakeLogger();
      const tracer: Tracer = {
        startSpan() {
          throw new Error('startSpan exploded');
        },
      };

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, retry: { attempts: 2 } }))
        .addStep(new Step<Ctx>('b', { run: () => {}, undo: () => {} }))
        .addStep(
          new Step<Ctx>('c', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer, logger });

      expect(result.ok).toBe(false);
      // 'a' declares no undo, so it stays completed; 'b' does and rolls back.
      expect(result.steps.map((s) => s.status)).toEqual([
        'completed',
        'rolled-back',
        'failed',
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        'tracer threw',
        expect.objectContaining({
          call: 'startSpan',
          errorType: 'Error',
          errorMessage: 'startSpan exploded',
        }),
      );
    });

    it('contains a tracer whose span methods all throw', async () => {
      const logger = fakeLogger();

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, undo: () => {} }))
        .addStep(new Step<Ctx>('b', { run: () => {}, retry: { attempts: 2 } }))
        .addStep(
          new Step<Ctx>('c', () => {
            throw new Error('nope');
          }),
        )
        .execute({}, { tracer: hostileTracer(), logger });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Step "c" failed');
      expect(result.steps.map((s) => s.status)).toEqual([
        'rolled-back',
        'completed',
        'failed',
      ]);
      const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter(([message]) => message === 'tracer threw')
        .map(([, meta]) => (meta as { call: string }).call);
      expect(new Set(calls)).toEqual(
        new Set(['setAttribute', 'recordException', 'setStatus', 'end']),
      );
    });

    it('keeps a successful run successful under a hostile tracer', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', (ctx) => {
            ctx.marker = 'ran';
          }),
        )
        .execute({}, { tracer: hostileTracer() });

      expect(result.ok).toBe(true);
      expect(result.context.marker).toBe('ran');
      expect(result.error).toBeNull();
    });

    it('contains a tracer that returns a span missing its methods', async () => {
      const logger = fakeLogger();
      const tracer = {
        startSpan: () => ({}),
      } as unknown as Tracer;

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { tracer, logger });

      expect(result.ok).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        'tracer threw',
        expect.objectContaining({ call: 'setAttribute' }),
      );
    });
  });

  describe('dry-run', () => {
    it('emits no spans at all while planning (section 1.8)', async () => {
      const { tracer, spans } = fakeTracer();

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .addParallel([
          new Step<Ctx>('b', () => {}),
          new Step<Ctx>('c', { run: () => {}, when: () => false }),
        ])
        .execute({}, { tracer, dryRun: true });

      expect(result.steps.map((s) => s.status)).toEqual([
        'would-run',
        'would-run',
        'skipped',
      ]);
      expect(spans).toHaveLength(0);
    });
  });

  describe('nested pipelines (asStep)', () => {
    it('parents the inner pipeline span to the wrapping step span', async () => {
      const { tracer, spans } = fakeTracer();
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {}),
      );

      await new Pipeline<Ctx>('outer')
        .addStep(new Step<Ctx>('before', () => {}))
        .addStep(inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }))
        .execute({}, { tracer });

      const outerPipeline = only(spans, 'penstock.pipeline outer');
      const wrap = only(spans, 'penstock.step wrap');
      const innerPipeline = only(spans, 'penstock.pipeline inner');
      expect(wrap.parent).toBe(outerPipeline);
      expect(innerPipeline.parent).toBe(wrap);
      expect(only(spans, 'penstock.step i1').parent).toBe(innerPipeline);
    });

    it('gives the inner run its own execution id attribute', async () => {
      const { tracer, spans } = fakeTracer();
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {}),
      );

      const result = await new Pipeline<Ctx>('outer')
        .addStep(inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }))
        .execute({}, { tracer });

      const outerId = only(spans, 'penstock.pipeline outer').attributes.get(
        'penstock.execution.id',
      );
      const innerId = only(spans, 'penstock.pipeline inner').attributes.get(
        'penstock.execution.id',
      );
      expect(outerId).toBe(result.executionId);
      expect(innerId).toBe(result.steps[0]!.innerResult!.executionId);
      expect(innerId).not.toBe(outerId);
    });

    it('nests a wrapping step that lives inside a parallel group', async () => {
      const { tracer, spans } = fakeTracer();
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {}),
      );

      await new Pipeline<Ctx>('outer')
        .addParallel([
          inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }),
          new Step<Ctx>('sibling', () => {}),
        ])
        .execute({}, { tracer });

      expect(only(spans, 'penstock.pipeline inner').parent).toBe(
        only(spans, 'penstock.step wrap'),
      );
    });

    it('still traces the inner run when the wrapping step span could not start', async () => {
      const started: string[] = [];
      const tracer: Tracer = {
        startSpan(name, parent) {
          if (name.startsWith('penstock.step')) {
            throw new Error('no step spans today');
          }
          started.push(
            `${name} <- ${parent === undefined ? 'root' : 'parent'}`,
          );
          return {
            setAttribute() {},
            recordException() {},
            setStatus() {},
            end() {},
          };
        },
      };
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {}),
      );

      const result = await new Pipeline<Ctx>('outer')
        .addStep(inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }))
        .execute({}, { tracer });

      expect(result.ok).toBe(true);
      // There is no wrapping span to hang the inner run off, so it is traced
      // as a root — never dropped, and never a crash.
      expect(started).toEqual([
        'penstock.pipeline outer <- root',
        'penstock.pipeline inner <- root',
      ]);
    });

    it('emits no inner spans when the outer run supplies no tracer', async () => {
      const { spans } = fakeTracer();
      const inner = new Pipeline<BaseContext>('inner').addStep(
        new Step<BaseContext>('i1', () => {}),
      );

      const result = await new Pipeline<Ctx>('outer')
        .addStep(inner.asStep<Ctx>('wrap', { mapInput: () => ({}) }))
        .execute({});

      expect(result.ok).toBe(true);
      expect(spans).toHaveLength(0);
    });
  });

  // The executor never produces these shapes — a failed Result always carries
  // its error — but the span helpers guard against them anyway, so the guards
  // are exercised directly rather than left as untested defensive code.
  describe('defensive rendering of an outcome with no error', () => {
    it('marks a pipeline span error even when a failed Result has none', () => {
      const { tracer, spans } = fakeTracer();
      const span = createTracing(tracer, noopLogger).pipeline('p', undefined);

      const result: Result<BaseContext> = {
        ok: false,
        context: {} as BaseContext,
        steps: [],
        error: null,
        rollbackErrors: [],
        aborted: true,
        executionId: 'exec-1',
        pipelineName: 'p',
        durationMs: 3,
      };
      recordPipelineOutcome(span, result);

      const record = only(spans, 'penstock.pipeline p');
      expect(record.exceptions).toEqual([]);
      expect(record.statuses).toEqual([{ status: 'error' }]);
    });

    it('marks a step span error even when a failed report has none', () => {
      const { tracer, spans } = fakeTracer();
      const tracing = createTracing(tracer, noopLogger);
      const span = tracing.step('a', tracing.pipeline('p', undefined));

      recordStepOutcome(span, { status: 'failed', durationMs: 2 });

      const record = only(spans, 'penstock.step a');
      expect(record.exceptions).toEqual([]);
      expect(record.statuses).toEqual([{ status: 'error' }]);
    });
  });
});
