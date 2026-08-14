import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepMeta, StepReport } from '../src/types';

interface Ctx extends BaseContext {
  marker?: string;
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report(result: Result<Ctx>, name: string): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

/** Resolves after `ms` of real time. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A cooperative run that never finishes on its own: it settles only by
 * rejecting with `meta.signal.reason` when that signal aborts — the level that
 * carries a peer failure as well as a pipeline cancel (0.4.0 spec, section 1.3).
 */
const cooperativeRun = (_ctx: Ctx, meta: StepMeta): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    meta.signal.addEventListener('abort', () => reject(meta.signal.reason), {
      once: true,
    });
  });

/**
 * Builds steps that record how many of them overlap. `max` is the high-water
 * mark of simultaneously running steps — precisely what a concurrency limit
 * caps — and `starts` / `ends` record dispatch and completion order.
 */
function makeTracker(): {
  state: { live: number; max: number; starts: string[]; ends: string[] };
  step: (name: string, ms?: number) => Step<Ctx>;
} {
  const state = {
    live: 0,
    max: 0,
    starts: [] as string[],
    ends: [] as string[],
  };
  const step = (name: string, ms = 10): Step<Ctx> =>
    new Step<Ctx>(name, async () => {
      state.live += 1;
      state.max = Math.max(state.max, state.live);
      state.starts.push(name);
      await sleep(ms);
      state.live -= 1;
      state.ends.push(name);
    });
  return { state, step };
}

describe('parallel concurrency limits (section 1.5)', () => {
  describe('the bounded pool', () => {
    it('never runs more than `concurrency` steps at once', async () => {
      const { state, step } = makeTracker();
      const result = await new Pipeline<Ctx>('p')
        .addParallel([step('a'), step('b'), step('c'), step('d'), step('e')], {
          concurrency: 2,
        })
        .execute({});

      expect(result.ok).toBe(true);
      // Exactly 2 — the limit is a cap, not a serialisation.
      expect(state.max).toBe(2);
      expect(result.steps.map((s) => s.status)).toEqual(
        Array.from({ length: 5 }, () => 'completed'),
      );
    });

    it('behaves identically to 0.3.0 when concurrency is omitted or at/above the group size', async () => {
      const runs = [
        { label: 'omitted', options: undefined },
        { label: 'equal to the group size', options: { concurrency: 3 } },
        { label: 'above the group size', options: { concurrency: 99 } },
      ];

      for (const { options } of runs) {
        const { state, step } = makeTracker();
        const steps = [step('a'), step('b'), step('c')];
        const pipeline = new Pipeline<Ctx>('p');
        const result = await (
          options === undefined
            ? pipeline.addParallel(steps)
            : pipeline.addParallel(steps, options)
        ).execute({});

        expect(result.ok).toBe(true);
        // All three overlap: the pool never made anything wait.
        expect(state.max).toBe(3);
        expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
          'a:completed',
          'b:completed',
          'c:completed',
        ]);
      }
    });

    it('dispatches in declaration order as slots free, and still reports in declaration order', async () => {
      const starts: string[] = [];
      const ends: string[] = [];
      const mk = (name: string, ms: number): Step<Ctx> =>
        new Step<Ctx>(name, async () => {
          starts.push(name);
          await sleep(ms);
          ends.push(name);
        });

      const result = await new Pipeline<Ctx>('p')
        .addParallel([mk('a', 80), mk('b', 10), mk('c', 10), mk('d', 10)], {
          concurrency: 2,
        })
        .execute({});

      expect(result.ok).toBe(true);
      // 'a' holds one slot throughout; the other slot takes b, then c, then d.
      expect(starts).toEqual(['a', 'b', 'c', 'd']);
      // Completion order is genuinely different from declaration order…
      expect(ends).toEqual(['b', 'c', 'd', 'a']);
      // …but the reports are not (0.3.0 spec, section 1.1.5).
      expect(result.steps.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('guards', () => {
    it('evaluates every guard sequentially before any pooled run starts', async () => {
      const trail: string[] = [];
      const mk = (name: string, pass: boolean): Step<Ctx> =>
        new Step<Ctx>(name, {
          when: () => {
            trail.push(`guard:${name}`);
            return pass;
          },
          run: async () => {
            trail.push(`run:${name}`);
            await sleep(10);
          },
        });

      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [mk('a', true), mk('b', false), mk('c', true), mk('d', true)],
          {
            concurrency: 2,
          },
        )
        .execute({});

      expect(result.ok).toBe(true);
      // Every guard runs, in declaration order, before any concurrent work.
      expect(trail.slice(0, 4)).toEqual([
        'guard:a',
        'guard:b',
        'guard:c',
        'guard:d',
      ]);
      expect(trail.slice(4)).toEqual(['run:a', 'run:c', 'run:d']);
    });

    it('never lets a guard-skipped step occupy a slot', async () => {
      const skippedRun = vi.fn();
      const { state, step } = makeTracker();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('skipped-one', {
              run: skippedRun,
              when: () => false,
            }),
            step('a'),
            step('b'),
          ],
          { concurrency: 2 },
        )
        .execute({});

      expect(result.ok).toBe(true);
      expect(skippedRun).not.toHaveBeenCalled();
      // Both runnable steps overlap: the skipped one consumed neither slot.
      expect(state.max).toBe(2);
      expect(report(result, 'skipped-one').status).toBe('skipped');
      expect(report(result, 'skipped-one').skipReason).toBe(
        'guard returned false',
      );
    });
  });

  describe('failure inside a bounded pool', () => {
    it('cancels in-flight peers, never dispatches queued ones, and reports both as skipped', async () => {
      const queuedRun = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('boom', async () => {
              await sleep(10);
              throw new Error('peer failed');
            }),
            new Step<Ctx>('in-flight', cooperativeRun),
            new Step<Ctx>('queued-a', queuedRun),
            new Step<Ctx>('queued-b', queuedRun),
          ],
          { concurrency: 2 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      expect(report(result, 'boom').status).toBe('failed');
      // One reason for both the cancelled peer and the never-dispatched ones —
      // no new StepStatus, no new skipReason (section 1.5).
      for (const name of ['in-flight', 'queued-a', 'queued-b']) {
        expect(report(result, name).status).toBe('skipped');
        expect(report(result, name).skipReason).toBe(
          'cancelled (parallel peer failed)',
        );
      }
      expect(queuedRun).not.toHaveBeenCalled();
      expect((result.error as StepError).stepName).toBe('boom');
    });

    it('never calls the run of a step still queued when an earlier one fails', async () => {
      const queuedRun = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('boom', () => {
              throw new Error('first failure');
            }),
            new Step<Ctx>('queued', queuedRun),
          ],
          { concurrency: 1 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      // The whole point of the queue check: the step never ran at all.
      expect(queuedRun).not.toHaveBeenCalled();
      const queued = report(result, 'queued');
      expect(queued.status).toBe('skipped');
      expect(queued.skipReason).toBe('cancelled (parallel peer failed)');
      expect(queued.durationMs).toBe(0);
      // It never ran, so it carries neither an attempt count nor a key.
      expect(queued.attempts).toBeUndefined();
      expect(queued.idempotencyKey).toBeUndefined();
    });

    it('rolls back completed pooled steps in reverse declaration order, then prior entries', async () => {
      const trail: string[] = [];
      const ok = (name: string, ms: number): Step<Ctx> =>
        new Step<Ctx>(name, {
          run: () => sleep(ms),
          undo: () => {
            trail.push(`undo:${name}`);
          },
        });

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('prior', {
            run: () => {},
            undo: () => {
              trail.push('undo:prior');
            },
          }),
        )
        .addParallel(
          [
            ok('a', 60),
            ok('b', 5),
            ok('c', 5),
            new Step<Ctx>('boom', () => {
              throw new Error('boom');
            }),
          ],
          { concurrency: 2 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(report(result, 'boom').status).toBe('failed');
      // 'b' and 'c' completed before 'a' did, yet the group is undone in
      // reverse *declaration* order, then the prior entry (0.3.0 section 1.1.3).
      expect(trail).toEqual(['undo:c', 'undo:b', 'undo:a', 'undo:prior']);
      for (const name of ['a', 'b', 'c', 'prior']) {
        expect(report(result, name).status).toBe('rolled-back');
      }
      expect(result.rollbackErrors).toEqual([]);
    });

    it('surfaces the first failure in declaration order even when a later one fails first', async () => {
      const errA = new Error('a-fail');
      const errB = new Error('b-fail');
      const queuedRun = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('fail-a', async () => {
              await sleep(30);
              throw errA;
            }),
            new Step<Ctx>('fail-b', async () => {
              await sleep(5);
              throw errB;
            }),
            new Step<Ctx>('queued', queuedRun),
          ],
          { concurrency: 2 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      // 'fail-b' failed first in time and aborted the group; 'fail-a' was still
      // in flight and kept its own genuine failure.
      expect(report(result, 'fail-a').status).toBe('failed');
      expect(report(result, 'fail-b').status).toBe('failed');
      expect((result.error as StepError).stepName).toBe('fail-a');
      expect((result.error as StepError).cause).toBe(errA);
      expect(queuedRun).not.toHaveBeenCalled();
    });

    it('stops dispatching and cancels peers when a pooled step cannot resolve its key', async () => {
      const raw = new Error('cannot derive key');
      const queuedRun = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('bad-key', {
              run: () => {},
              idempotencyKey: () => {
                throw raw;
              },
            }),
            new Step<Ctx>('peer', cooperativeRun),
            new Step<Ctx>('queued', queuedRun),
          ],
          { concurrency: 1 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect((result.error as StepError).stepName).toBe('bad-key');
      expect((result.error as StepError).cause).toBe(raw);
      expect(report(result, 'peer').skipReason).toBe(
        'cancelled (parallel peer failed)',
      );
      expect(queuedRun).not.toHaveBeenCalled();
    });
  });

  describe('retry and timeout on pooled steps', () => {
    it('keeps every attempt of a retried step inside its one slot', async () => {
      let calls = 0;
      const { state, step } = makeTracker();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('flaky', {
              run: () => {
                calls += 1;
                if (calls < 3) throw new Error(`attempt-${calls}`);
              },
              retry: { attempts: 3, delayMs: 1 },
            }),
            step('steady', 5),
            step('other', 5),
          ],
          { concurrency: 1 },
        )
        .execute({});

      expect(result.ok).toBe(true);
      expect(calls).toBe(3);
      expect(report(result, 'flaky').attempts).toBe(3);
      // Concurrency 1: the retries finish before the next step is dispatched.
      expect(state.max).toBe(1);
      expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
    });

    it('applies a per-step timeout in the pool and stops dispatching after it fails', async () => {
      const queuedRun = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            // Never resolves; only its 20ms timeout ends the attempt.
            new Step<Ctx>('slow', {
              run: () => new Promise<void>(() => {}),
              timeout: 20,
            }),
            new Step<Ctx>('queued', queuedRun),
          ],
          { concurrency: 1 },
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      const slow = report(result, 'slow');
      expect(slow.status).toBe('failed');
      expect(slow.timedOut).toBe(true);
      expect(((result.error as StepError).cause as Error).name).toBe(
        'TimeoutError',
      );
      expect(queuedRun).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('cancels in-flight steps, never dispatches queued ones, and sets aborted', async () => {
      const controller = new AbortController();
      const reason = new Error('cancel mid-pool');
      const undoDone = vi.fn();
      const queuedRun = vi.fn();

      const result = await new Pipeline<Ctx>('p')
        .addParallel(
          [
            new Step<Ctx>('done', { run: () => sleep(5), undo: undoDone }),
            new Step<Ctx>('waiting', (ctx, meta) => {
              // Fire the pipeline cancel while this step is in flight.
              setTimeout(() => controller.abort(reason), 0);
              return cooperativeRun(ctx, meta);
            }),
            new Step<Ctx>('queued', queuedRun),
          ],
          { concurrency: 2 },
        )
        .execute({}, { signal: controller.signal });

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(true);
      // The abort reason surfaces raw, not wrapped in a StepError.
      expect(result.error).toBe(reason);
      // A pipeline-level cancel marks both the in-flight and the queued step
      // plainly 'cancelled', not 'cancelled (parallel peer failed)'.
      for (const name of ['waiting', 'queued']) {
        expect(report(result, name).status).toBe('skipped');
        expect(report(result, name).skipReason).toBe('cancelled');
      }
      expect(queuedRun).not.toHaveBeenCalled();
      expect(undoDone).toHaveBeenCalledTimes(1);
      expect(report(result, 'done').status).toBe('rolled-back');
    });
  });

  describe('dry-run', () => {
    it('plans a bounded group exactly like an unbounded one', async () => {
      const run = vi.fn();
      const undo = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('first', { run, undo }))
        .addParallel(
          [
            new Step<Ctx>('a', { run, undo }),
            new Step<Ctx>('b', { run, undo, when: () => false }),
            new Step<Ctx>('c', { run, undo }),
          ],
          { concurrency: 1 },
        )
        .execute({}, { dryRun: true });

      expect(result.ok).toBe(true);
      expect(result.aborted).toBe(false);
      // Nothing executes, so the limit is irrelevant (section 1.5).
      expect(run).not.toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
      expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
        'first:would-run',
        'a:would-run',
        'b:skipped',
        'c:would-run',
      ]);
    });
  });

  describe('validation', () => {
    const pair = (): Step<Ctx>[] => [
      new Step<Ctx>('a', () => {}),
      new Step<Ctx>('b', () => {}),
    ];

    it.each([
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction', 1.5],
      ['NaN', Number.NaN],
      ['a numeric string', '2'],
      ['null', null],
    ])('throws a UsageError when concurrency is %s', (_label, value) => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel(pair(), {
          concurrency: value as unknown as number,
        }),
      ).toThrow(UsageError);
    });

    it('accepts a positive integer, an empty options object, and no options', () => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel(pair(), { concurrency: 1 }),
      ).not.toThrow();
      expect(() =>
        new Pipeline<Ctx>('p').addParallel(pair(), {}),
      ).not.toThrow();
      expect(() => new Pipeline<Ctx>('p').addParallel(pair())).not.toThrow();
    });

    it('registers no step names when the concurrency option is invalid', () => {
      const pipeline = new Pipeline<Ctx>('p');
      expect(() => pipeline.addParallel(pair(), { concurrency: 0 })).toThrow(
        UsageError,
      );
      // 'a' and 'b' were not half-registered by the failed call.
      expect(() => pipeline.addParallel(pair())).not.toThrow();
    });
  });

  describe('re-entrancy', () => {
    it('keeps the pools of two concurrent executions independent', async () => {
      interface PoolCtx extends BaseContext<{ tag: string }> {
        live?: number;
        max?: number;
        order?: string[];
      }
      const track = (name: string): Step<PoolCtx> =>
        new Step<PoolCtx>(name, async (ctx) => {
          ctx.live = (ctx.live ?? 0) + 1;
          ctx.max = Math.max(ctx.max ?? 0, ctx.live);
          (ctx.order ??= []).push(name);
          await sleep(10);
          ctx.live = (ctx.live ?? 0) - 1;
        });

      const pipeline = new Pipeline<PoolCtx>('pool').addParallel(
        [track('a'), track('b'), track('c'), track('d')],
        { concurrency: 2 },
      );

      const [r1, r2] = await Promise.all([
        pipeline.execute({ tag: 'one' }),
        pipeline.execute({ tag: 'two' }),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // Each run pools its own steps: neither saw more than 2 of its own live,
      // and neither starved the other (all four ran in both).
      expect(r1.context.max).toBe(2);
      expect(r2.context.max).toBe(2);
      expect(r1.context.order).toEqual(['a', 'b', 'c', 'd']);
      expect(r2.context.order).toEqual(['a', 'b', 'c', 'd']);
      expect(r1.executionId).not.toBe(r2.executionId);
      expect(r1.context).not.toBe(r2.context);
    });
  });
});
