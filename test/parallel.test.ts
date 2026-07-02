import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError, UsageError } from '../src/errors';
import type { Logger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepReport } from '../src/types';

interface Ctx extends BaseContext {
  inventory?: string;
  pricing?: string;
  marker?: string;
}

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

/** A logger that records every call so tests can inspect what was logged. */
function makeCapturingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall['level']) =>
    (msg: string, meta?: Record<string, unknown>) => {
      calls.push({ level, msg, meta });
    };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    calls,
  };
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report(result: Result<Ctx>, name: string): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

/** A run that resolves after `ms` of real time. */
const sleepRun = (ms: number) => () =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A cooperative run that never finishes on its own: it settles only by
 * rejecting with `ctx.signal.reason` when the signal aborts (the pattern the
 * README recommends for forwarding cancellation into a step's own async work).
 */
const cooperativeRun = (ctx: Ctx) =>
  new Promise<void>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), {
      once: true,
    });
  });

describe('Pipeline parallel groups (0.3.0 section 1.1)', () => {
  describe('basic execution', () => {
    it('runs both parallel steps, then continues to the next sequential step', async () => {
      const trail: string[] = [];
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', () => {
            trail.push('a');
          }),
          new Step<Ctx>('b', () => {
            trail.push('b');
          }),
        ])
        .addStep(
          new Step<Ctx>('after-group', () => {
            trail.push('after-group');
          }),
        )
        .execute({});

      expect(result.ok).toBe(true);
      expect(result.aborted).toBe(false);
      expect(report(result, 'a').status).toBe('completed');
      expect(report(result, 'b').status).toBe('completed');
      expect(report(result, 'after-group').status).toBe('completed');
      // The sequential step runs only after the whole group settles.
      expect(trail[trail.length - 1]).toBe('after-group');
    });

    it('runs three parallel steps concurrently, not sequentially', async () => {
      const start = performance.now();
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', sleepRun(50)),
          new Step<Ctx>('b', sleepRun(50)),
          new Step<Ctx>('c', sleepRun(50)),
        ])
        .execute({});
      const elapsed = performance.now() - start;

      expect(result.ok).toBe(true);
      expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
      // Three 50ms steps in parallel finish in ~50ms; sequentially they would
      // take ~150ms. A generous bound keeps this robust on slow CI runners.
      expect(elapsed).toBeLessThan(140);
    });

    it('reports parallel steps in declaration order regardless of completion order', async () => {
      const completions: string[] = [];
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('first', () => {}))
        .addParallel([
          new Step<Ctx>('slow', async () => {
            await sleepRun(40)();
            completions.push('slow');
          }),
          new Step<Ctx>('fast', async () => {
            await sleepRun(5)();
            completions.push('fast');
          }),
        ])
        .execute({});

      // 'fast' completed first…
      expect(completions).toEqual(['fast', 'slow']);
      // …but the reports stay in declaration order (section 1.1.5).
      expect(result.steps.map((s) => s.name)).toEqual([
        'first',
        'slow',
        'fast',
      ]);
    });
  });

  describe('guards', () => {
    it('skips a guarded-out parallel step while the others still run', async () => {
      const run = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('skipped-one', { run, when: () => false }),
          new Step<Ctx>('runs', () => {}),
        ])
        .execute({});

      expect(result.ok).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(report(result, 'skipped-one').status).toBe('skipped');
      expect(report(result, 'skipped-one').skipReason).toBe(
        'guard returned false',
      );
      expect(report(result, 'runs').status).toBe('completed');
    });

    it('aborts the group before any step runs when a guard throws, and rolls back', async () => {
      const undoPrior = vi.fn();
      const runA = vi.fn();
      const runB = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('prior', { run: () => {}, undo: undoPrior }))
        .addParallel([
          new Step<Ctx>('a', runA),
          new Step<Ctx>('bad-guard', {
            run: runB,
            when: () => {
              throw new Error('guard boom');
            },
          }),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      // No parallel step ran: guards are evaluated before any concurrent work.
      expect(runA).not.toHaveBeenCalled();
      expect(runB).not.toHaveBeenCalled();
      expect(report(result, 'bad-guard').status).toBe('failed');
      expect(result.error).toBeInstanceOf(StepError);
      expect(undoPrior).toHaveBeenCalledTimes(1);
      expect(report(result, 'prior').status).toBe('rolled-back');
    });

    it('keeps guard-skip reports for steps evaluated before a throwing guard', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('skipped-first', { run: () => {}, when: () => false }),
          new Step<Ctx>('cleared', () => {}),
          new Step<Ctx>('bad-guard', {
            run: () => {},
            when: () => {
              throw new Error('guard boom');
            },
          }),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      // The guard-skipped step reached a terminal state and keeps its report;
      // 'cleared' passed its guard but never started, so it gets none (same
      // as steps after a sequential failure).
      expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
        'skipped-first:skipped',
        'bad-guard:failed',
      ]);
    });

    it('continues to the next entry when every guard returns false', async () => {
      const after = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', { run: () => {}, when: () => false }),
          new Step<Ctx>('b', { run: () => {}, when: () => false }),
        ])
        .addStep(new Step<Ctx>('after-group', after))
        .execute({});

      expect(result.ok).toBe(true);
      expect(report(result, 'a').status).toBe('skipped');
      expect(report(result, 'b').status).toBe('skipped');
      expect(after).toHaveBeenCalledTimes(1);
      expect(report(result, 'after-group').status).toBe('completed');
    });
  });

  describe('failure and rollback', () => {
    it('rolls back completed group steps in reverse declaration order, then prior steps', async () => {
      const trail: string[] = [];
      const mk = (name: string, fail = false) =>
        new Step<Ctx>(name, {
          run: () => {
            if (fail) throw new Error(`${name}-fail`);
          },
          undo: () => {
            trail.push(`undo:${name}`);
          },
        });

      const result = await new Pipeline<Ctx>('p')
        .addStep(mk('prior'))
        .addParallel([mk('a'), mk('boom', true), mk('c')])
        .execute({});

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      expect(report(result, 'boom').status).toBe('failed');
      // Reverse declaration order within the group ('c' before 'a'), then the
      // prior sequential step (section 1.1.3).
      expect(trail).toEqual(['undo:c', 'undo:a', 'undo:prior']);
      expect(report(result, 'a').status).toBe('rolled-back');
      expect(report(result, 'c').status).toBe('rolled-back');
      expect(report(result, 'prior').status).toBe('rolled-back');
      expect(result.rollbackErrors).toEqual([]);
    });

    it('cancels an in-flight cooperative peer when a parallel step fails', async () => {
      const undoPrior = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('prior', { run: () => {}, undo: undoPrior }))
        .addParallel([
          new Step<Ctx>('boom', () => {
            throw new Error('peer failed');
          }),
          // Never settles on its own — only the group abort ends it.
          new Step<Ctx>('in-flight', cooperativeRun),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      expect(report(result, 'boom').status).toBe('failed');
      const peer = report(result, 'in-flight');
      expect(peer.status).toBe('skipped');
      expect(peer.skipReason).toBe('cancelled (parallel peer failed)');
      expect(undoPrior).toHaveBeenCalledTimes(1);
      expect(report(result, 'prior').status).toBe('rolled-back');
      // result.error is the failing step's error, not the peer cancellation.
      expect(result.error).toBeInstanceOf(StepError);
      expect((result.error as StepError).stepName).toBe('boom');
    });

    it('surfaces the first failure by declaration order when multiple steps fail', async () => {
      const errA = new Error('a-fail');
      const errB = new Error('b-fail');
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('fail-a', () => {
            throw errA;
          }),
          new Step<Ctx>('fail-b', () => {
            throw errB;
          }),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      // Both failures are recorded on their own reports…
      expect(report(result, 'fail-a').status).toBe('failed');
      expect(report(result, 'fail-b').status).toBe('failed');
      expect((report(result, 'fail-a').error as StepError).cause).toBe(errA);
      expect((report(result, 'fail-b').error as StepError).cause).toBe(errB);
      // …but result.error is the first in declaration order (section 1.1.3).
      expect((result.error as StepError).stepName).toBe('fail-a');
      expect((result.error as StepError).cause).toBe(errA);
    });

    it('keeps a genuine failure failed even when it arrives after the group abort', async () => {
      const ownError = new Error('own failure after abort');
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('boom', () => {
            throw new Error('first failure');
          }),
          new Step<Ctx>('late-fail', {
            run: (ctx) =>
              new Promise<void>((_resolve, reject) => {
                // Rejects with its OWN error once the group abort arrives — a
                // genuine failure racing the abort, not a cooperative cancel
                // (which would reject with the abort reason itself).
                ctx.signal.addEventListener('abort', () => reject(ownError), {
                  once: true,
                });
              }),
          }),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      expect(report(result, 'boom').status).toBe('failed');
      // Not misclassified as cancelled: the rejection was not the abort reason.
      expect(report(result, 'late-fail').status).toBe('failed');
      expect((report(result, 'late-fail').error as StepError).cause).toBe(
        ownError,
      );
      // result.error is still the first failure by declaration order.
      expect((result.error as StepError).stepName).toBe('boom');
    });

    it('collects a throwing parallel undo as rollback-failed and still runs the rest', async () => {
      const trail: string[] = [];
      const undoErr = new Error('undo-a failed');
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              trail.push('undo:a');
              throw undoErr;
            },
          }),
          new Step<Ctx>('b', {
            run: () => {},
            undo: () => {
              trail.push('undo:b');
            },
          }),
        ])
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('later failure');
          }),
        )
        .execute({});

      expect(result.ok).toBe(false);
      // Best-effort: b's undo (reverse order first) succeeded, a's threw,
      // and the throw did not abort the walk.
      expect(trail).toEqual(['undo:b', 'undo:a']);
      expect(report(result, 'a').status).toBe('rollback-failed');
      expect(report(result, 'b').status).toBe('rolled-back');
      expect(result.rollbackErrors).toEqual([undoErr]);
    });
  });

  describe('context sharing', () => {
    it('makes writes to distinct context keys both visible after the group', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('inventory', (ctx) => {
            ctx.inventory = 'reserved';
          }),
          new Step<Ctx>('pricing', (ctx) => {
            ctx.pricing = 'computed';
          }),
        ])
        .addStep(
          new Step<Ctx>('check', (ctx) => {
            ctx.marker = `${ctx.inventory}+${ctx.pricing}`;
          }),
        )
        .execute({});

      expect(result.ok).toBe(true);
      expect(result.context.inventory).toBe('reserved');
      expect(result.context.pricing).toBe('computed');
      expect(result.context.marker).toBe('reserved+computed');
    });
  });

  describe('interaction with retry and timeout', () => {
    it('retries a flaky parallel step and reports attempts', async () => {
      let calls = 0;
      const run = vi.fn(() => {
        calls += 1;
        if (calls < 3) throw new Error(`attempt-${calls}`);
      });

      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('flaky', { run, retry: { attempts: 3, delayMs: 0 } }),
          new Step<Ctx>('steady', () => {}),
        ])
        .execute({});

      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledTimes(3);
      expect(report(result, 'flaky').status).toBe('completed');
      expect(report(result, 'flaky').attempts).toBe(3);
      expect(report(result, 'steady').status).toBe('completed');
    });

    it('fails a parallel step that exceeds its timeout with timedOut: true', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          // Never resolves; only its 20ms timeout ends the attempt.
          new Step<Ctx>('slow', {
            run: () => new Promise<void>(() => {}),
            timeout: 20,
          }),
          new Step<Ctx>('quick', () => {}),
        ])
        .execute({});

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      const slow = report(result, 'slow');
      expect(slow.status).toBe('failed');
      expect(slow.timedOut).toBe(true);
      expect(((result.error as StepError).cause as Error).name).toBe(
        'TimeoutError',
      );
    });
  });

  describe('cancellation', () => {
    it('cancels in-flight steps, rolls back completed ones, and sets aborted', async () => {
      const controller = new AbortController();
      const reason = new Error('cancel mid-group');
      const undoDone = vi.fn();

      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('done', { run: () => {}, undo: undoDone }),
          new Step<Ctx>('waiting', {
            run: (ctx) => {
              // Fire the pipeline cancel while this step is in flight.
              setTimeout(() => controller.abort(reason), 0);
              return cooperativeRun(ctx);
            },
          }),
        ])
        .addStep(new Step<Ctx>('later', () => {}))
        .addParallel([
          new Step<Ctx>('never-a', () => {}),
          new Step<Ctx>('never-b', () => {}),
        ])
        .execute({}, { signal: controller.signal });

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(true);
      // The abort reason surfaces raw, not wrapped in a StepError (section 1.3).
      expect(result.error).toBe(reason);
      // A pipeline-level cancel marks in-flight steps plainly 'cancelled'.
      expect(report(result, 'waiting').status).toBe('skipped');
      expect(report(result, 'waiting').skipReason).toBe('cancelled');
      // The completed group step rolled back.
      expect(undoDone).toHaveBeenCalledTimes(1);
      expect(report(result, 'done').status).toBe('rolled-back');
      // Everything after the group — sequential and parallel — is cancelled.
      for (const name of ['later', 'never-a', 'never-b']) {
        expect(report(result, name).status).toBe('skipped');
        expect(report(result, name).skipReason).toBe('cancelled');
      }
    });
  });

  describe('dry-run', () => {
    it('plans parallel steps as would-run/skipped without calling run or undo', async () => {
      const run = vi.fn();
      const undo = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('first', { run, undo }))
        .addParallel([
          new Step<Ctx>('a', { run, undo }),
          new Step<Ctx>('b', { run, undo, when: () => false }),
        ])
        .execute({}, { dryRun: true });

      expect(result.ok).toBe(true);
      expect(result.aborted).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
      expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
        'first:would-run',
        'a:would-run',
        'b:skipped',
      ]);
    });
  });

  describe('validation', () => {
    it('rejects a group of fewer than 2 steps', () => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel([new Step<Ctx>('only', () => {})]),
      ).toThrow(UsageError);
      expect(() => new Pipeline<Ctx>('p').addParallel([])).toThrow(UsageError);
    });

    it('rejects a non-array argument', () => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel(
          'not-steps' as unknown as Step<Ctx>[],
        ),
      ).toThrow(UsageError);
    });

    it('rejects non-Step items', () => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel([
          new Step<Ctx>('real', () => {}),
          { name: 'fake' } as unknown as Step<Ctx>,
        ]),
      ).toThrow(UsageError);
    });

    it('rejects a duplicate name against an existing step and within the group', () => {
      expect(() =>
        new Pipeline<Ctx>('p')
          .addStep(new Step<Ctx>('dup', () => {}))
          .addParallel([
            new Step<Ctx>('dup', () => {}),
            new Step<Ctx>('other', () => {}),
          ]),
      ).toThrow(UsageError);
      expect(() =>
        new Pipeline<Ctx>('p').addParallel([
          new Step<Ctx>('twin', () => {}),
          new Step<Ctx>('twin', () => {}),
        ]),
      ).toThrow(UsageError);
    });

    it('rejects a reserved-name step (Step construction itself throws)', () => {
      expect(() =>
        new Pipeline<Ctx>('p').addParallel([
          new Step<Ctx>('ok', () => {}),
          new Step<Ctx>('__proto__', () => {}),
        ]),
      ).toThrow(UsageError);
    });

    it('does not register any group names when validation fails midway', () => {
      const pipeline = new Pipeline<Ctx>('p');
      expect(() =>
        pipeline.addParallel([
          new Step<Ctx>('fresh', () => {}),
          { name: 'fake' } as unknown as Step<Ctx>,
        ]),
      ).toThrow(UsageError);
      // 'fresh' was not half-registered by the failed call.
      expect(() =>
        pipeline.addParallel([
          new Step<Ctx>('fresh', () => {}),
          new Step<Ctx>('other', () => {}),
        ]),
      ).not.toThrow();
    });
  });

  describe('hooks', () => {
    it('fires before for each parallel step and after for each completed one', async () => {
      const befores: string[] = [];
      const afters: string[] = [];
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', () => {}),
          new Step<Ctx>('b', () => {}),
        ])
        .before((_ctx, step) => {
          befores.push(step.name);
        })
        .after((_ctx, step, r) => {
          afters.push(`${step.name}:${r.status}`);
        })
        .execute({});

      expect(result.ok).toBe(true);
      // before fires in declaration order (launch is sequential).
      expect(befores).toEqual(['a', 'b']);
      // after fires per completed step (completion order; both completed here).
      expect(afters.sort()).toEqual(['a:completed', 'b:completed']);
    });

    it('fires onError once per failed parallel step, before rollback', async () => {
      const trail: string[] = [];
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('prior', {
            run: () => {},
            undo: () => {
              trail.push('undo:prior');
            },
          }),
        )
        .addParallel([
          new Step<Ctx>('fail-a', () => {
            throw new Error('a');
          }),
          new Step<Ctx>('fail-b', () => {
            throw new Error('b');
          }),
        ])
        .onError((err) => {
          trail.push(`onError:${(err as StepError).stepName}`);
        })
        .execute({});

      expect(result.ok).toBe(false);
      // One onError per failed step, in declaration order, then rollback.
      expect(trail).toEqual(['onError:fail-a', 'onError:fail-b', 'undo:prior']);
    });

    it('contains a throwing before hook without affecting parallel execution', async () => {
      const { logger, calls } = makeCapturingLogger();
      const result = await new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('a', () => {}),
          new Step<Ctx>('b', () => {}),
        ])
        .before(() => {
          throw new Error('hook boom');
        })
        .execute({}, { logger });

      expect(result.ok).toBe(true);
      expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
      // One contained warn per step the hook fired for (section 1.8).
      expect(
        calls.filter((c) => c.level === 'warn' && c.meta?.hook === 'before'),
      ).toHaveLength(2);
    });
  });

  describe('re-entrancy', () => {
    it('produces independent results for concurrent executes of the same pipeline', async () => {
      interface NumCtx extends BaseContext<{ base: number }> {
        doubled?: number;
        tripled?: number;
      }
      const pipeline = new Pipeline<NumCtx>('reentrant').addParallel([
        new Step<NumCtx>('double', async (ctx) => {
          await Promise.resolve();
          ctx.doubled = ctx.input.base * 2;
        }),
        new Step<NumCtx>('triple', async (ctx) => {
          await Promise.resolve();
          ctx.tripled = ctx.input.base * 3;
        }),
      ]);

      const [r1, r2] = await Promise.all([
        pipeline.execute({ base: 2 }),
        pipeline.execute({ base: 10 }),
      ]);

      expect(r1.context.doubled).toBe(4);
      expect(r1.context.tripled).toBe(6);
      expect(r2.context.doubled).toBe(20);
      expect(r2.context.tripled).toBe(30);
      expect(r1.context).not.toBe(r2.context);
      expect(r1.steps).not.toBe(r2.steps);
    });
  });
});
