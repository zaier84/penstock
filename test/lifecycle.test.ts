import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { PipelineError } from '../src/errors';
import type { Logger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result } from '../src/types';

interface Input {
  n: number;
}

interface Ctx extends BaseContext<Input> {
  out?: number;
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

const ok = (name: string) => new Step<Ctx>(name, () => {});

const boom = (name: string) =>
  new Step<Ctx>(name, () => {
    throw new Error(`${name} failed`);
  });

describe('pipeline lifecycle events (0.3.0 section 1.3)', () => {
  describe('firing conditions', () => {
    it('fires onComplete then onSettled on success, with the returned Result', async () => {
      const events: string[] = [];
      let seenComplete: Result<Ctx> | undefined;
      let seenSettled: Result<Ctx> | undefined;
      const onFailure = vi.fn();
      const onCancel = vi.fn();
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete((result) => {
          seenComplete = result;
          events.push('complete');
        })
        .onFailure(onFailure)
        .onCancel(onCancel)
        .onSettled((result) => {
          seenSettled = result;
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 });

      expect(result.ok).toBe(true);
      expect(events).toEqual(['complete', 'settled']);
      // Both callbacks receive the exact Result object execute resolves with.
      expect(seenComplete).toBe(result);
      expect(seenSettled).toBe(result);
      expect(onFailure).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('fires onFailure after rollback completes, then onSettled, on a step failure', async () => {
      const events: string[] = [];
      const onComplete = vi.fn();
      const onCancel = vi.fn();
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s1', {
            run: () => {},
            undo: () => {
              events.push('undo:s1');
            },
          }),
        )
        .addStep(boom('s2'))
        .onComplete(onComplete)
        .onFailure((result) => {
          // Rollback already ran when the callback fires (section 1.3.2).
          events.push(`failure:${result.steps[0]?.status}`);
        })
        .onCancel(onCancel)
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 });

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      expect(events).toEqual(['undo:s1', 'failure:rolled-back', 'settled']);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('fires onCancel after rollback completes, then onSettled, on cancellation', async () => {
      const events: string[] = [];
      const onComplete = vi.fn();
      const onFailure = vi.fn();
      const controller = new AbortController();
      const reason = new Error('user cancelled');
      let seenCancel: Result<Ctx> | undefined;
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s1', {
            run: () => {},
            undo: () => {
              events.push('undo:s1');
            },
          }),
        )
        .addStep(
          new Step<Ctx>('s2', {
            // Completes, but aborts the pipeline signal so the next
            // between-entry check cancels the run (section 1.3).
            run: () => {
              controller.abort(reason);
            },
            undo: () => {
              events.push('undo:s2');
            },
          }),
        )
        .addStep(ok('s3'))
        .onComplete(onComplete)
        .onFailure(onFailure)
        .onCancel((result) => {
          seenCancel = result;
          events.push('cancel');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute(
        { n: 1 },
        { signal: controller.signal },
      );

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.error).toBe(reason);
      // Rollback (reverse order) precedes onCancel, which precedes onSettled.
      expect(events).toEqual(['undo:s2', 'undo:s1', 'cancel', 'settled']);
      expect(seenCancel).toBe(result);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('routes on result.aborted: a pre-aborted signal fires onCancel, never onFailure', async () => {
      const events: string[] = [];
      const controller = new AbortController();
      controller.abort(new Error('too late'));
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete(() => {
          events.push('complete');
        })
        .onFailure(() => {
          events.push('failure');
        })
        .onCancel(() => {
          events.push('cancel');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute(
        { n: 1 },
        { signal: controller.signal },
      );

      expect(result.aborted).toBe(true);
      expect(events).toEqual(['cancel', 'settled']);
    });
  });

  describe('order', () => {
    it('runs multiple callbacks of one type in registration order, onSettled last', async () => {
      const events: string[] = [];
      const push = (label: string) => () => {
        events.push(label);
      };
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete(push('c1'))
        .onSettled(push('settled1'))
        .onComplete(push('c2'))
        .onComplete(push('c3'))
        .onSettled(push('settled2'));

      await pipeline.execute({ n: 1 });

      expect(events).toEqual(['c1', 'c2', 'c3', 'settled1', 'settled2']);
    });
  });

  describe('containment (section 1.3.2)', () => {
    it('contains a throwing onComplete: logs at warn, later callbacks still fire, Result unchanged', async () => {
      const { logger, calls } = makeCapturingLogger();
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete(() => {
          throw new Error('observer exploded');
        })
        .onComplete(() => {
          events.push('complete2');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 }, { logger });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(events).toEqual(['complete2', 'settled']);
      const warn = calls.find((c) => c.level === 'warn');
      expect(warn?.msg).toBe('lifecycle callback threw');
      // Log hygiene (section 1.10): only the callback kind and the error's
      // type/message — never the result, context, or input.
      expect(warn?.meta).toEqual({
        callback: 'onComplete',
        errorType: 'Error',
        errorMessage: 'observer exploded',
      });
    });

    it('contains a throwing onFailure without altering the failed Result', async () => {
      const { logger, calls } = makeCapturingLogger();
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(boom('s1'))
        .onFailure(() => {
          throw new Error('failure observer exploded');
        })
        .onFailure(() => {
          events.push('failure2');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 }, { logger });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('s1');
      expect(events).toEqual(['failure2', 'settled']);
      expect(
        calls.some(
          (c) => c.level === 'warn' && c.meta?.callback === 'onFailure',
        ),
      ).toBe(true);
    });

    it('contains an async-rejecting onCancel; onSettled still fires', async () => {
      const { logger, calls } = makeCapturingLogger();
      const events: string[] = [];
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        // Rejections are contained the same way as synchronous throws.
        .onCancel(async () => {
          throw new Error('cancel observer exploded');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute(
        { n: 1 },
        { logger, signal: controller.signal },
      );

      expect(result.aborted).toBe(true);
      expect(events).toEqual(['settled']);
      expect(
        calls.some(
          (c) => c.level === 'warn' && c.meta?.callback === 'onCancel',
        ),
      ).toBe(true);
    });

    it('contains a throwing onSettled; later onSettled callbacks still fire', async () => {
      const { logger, calls } = makeCapturingLogger();
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onSettled(() => {
          throw new Error('settled observer exploded');
        })
        .onSettled(() => {
          events.push('settled2');
        });

      const result = await pipeline.execute({ n: 1 }, { logger });

      expect(result.ok).toBe(true);
      expect(events).toEqual(['settled2']);
      expect(
        calls.some(
          (c) => c.level === 'warn' && c.meta?.callback === 'onSettled',
        ),
      ).toBe(true);
    });
  });

  describe('async', () => {
    it('awaits an async lifecycle callback before firing the next one', async () => {
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 15));
          events.push('complete-done');
        })
        .onSettled(() => {
          events.push('settled');
        });

      await pipeline.execute({ n: 1 });

      // onSettled waited for the async onComplete; both finished before
      // execute resolved.
      expect(events).toEqual(['complete-done', 'settled']);
    });
  });

  describe('dry-run', () => {
    it('fires no lifecycle callbacks during dry-run, whatever the plan outcome', async () => {
      const onComplete = vi.fn();
      const onFailure = vi.fn();
      const onCancel = vi.fn();
      const onSettled = vi.fn();
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(ok('s1'))
        .onComplete(onComplete)
        .onFailure(onFailure)
        .onCancel(onCancel)
        .onSettled(onSettled);

      const plan = await pipeline.execute({ n: 1 }, { dryRun: true });
      expect(plan.ok).toBe(true);

      // Even a failed plan (a throwing guard) fires nothing — dry-run is
      // plan-only, no observers (section 1.3.2).
      const failingPlan = await new Pipeline<Ctx>('p2')
        .addStep(
          new Step<Ctx>('guarded', {
            run: () => {},
            when: () => {
              throw new Error('guard exploded');
            },
          }),
        )
        .onFailure(onFailure)
        .onSettled(onSettled)
        .execute({ n: 1 }, { dryRun: true });
      expect(failingPlan.ok).toBe(false);

      expect(onComplete).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
    });
  });

  describe('empty pipeline', () => {
    it('fires onComplete and onSettled for an empty pipeline', async () => {
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('empty')
        .onComplete(() => {
          events.push('complete');
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 });

      expect(result.ok).toBe(true);
      expect(result.steps).toEqual([]);
      expect(events).toEqual(['complete', 'settled']);
    });
  });

  describe('with parallel groups', () => {
    it('fires onFailure after a parallel group failure has been rolled back', async () => {
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addParallel([
          new Step<Ctx>('ok-step', {
            run: () => {},
            undo: () => {
              events.push('undo:ok-step');
            },
          }),
          boom('fail-step'),
        ])
        .onFailure((result) => {
          events.push(`failure:${result.error?.message ?? ''}`);
        })
        .onSettled(() => {
          events.push('settled');
        });

      const result = await pipeline.execute({ n: 1 });

      expect(result.ok).toBe(false);
      expect(events).toEqual([
        'undo:ok-step',
        'failure:Step "fail-step" failed',
        'settled',
      ]);
    });
  });

  describe('with pipeline-as-step', () => {
    interface InnerInput {
      k: number;
    }
    type InnerCtx = BaseContext<InnerInput>;

    it('fires inner and outer lifecycles independently: inner success, later outer failure', async () => {
      const events: string[] = [];
      const inner = new Pipeline<InnerCtx>('inner')
        .addStep(new Step<InnerCtx>('i1', () => {}))
        .onComplete(() => {
          events.push('inner-complete');
        })
        .onFailure(() => {
          events.push('inner-failure');
        })
        .onSettled(() => {
          events.push('inner-settled');
        });
      const outer = new Pipeline<Ctx>('outer')
        .addStep(
          inner.asStep<Ctx>('run-inner', {
            mapInput: (ctx) => ({ k: ctx.input.n }),
          }),
        )
        .addStep(boom('charge'))
        .onComplete(() => {
          events.push('outer-complete');
        })
        .onFailure(() => {
          events.push('outer-failure');
        })
        .onSettled(() => {
          events.push('outer-settled');
        });

      const result = await outer.execute({ n: 1 });

      expect(result.ok).toBe(false);
      // The inner run settled (successfully) while the outer was mid-flight;
      // each pipeline's lifecycle reflects only its own Result.
      expect(events).toEqual([
        'inner-complete',
        'inner-settled',
        'outer-failure',
        'outer-settled',
      ]);
    });

    it('fires inner onFailure and outer onFailure when the inner pipeline fails', async () => {
      const events: string[] = [];
      const inner = new Pipeline<InnerCtx>('inner')
        .addStep(
          new Step<InnerCtx>('i1', () => {
            throw new Error('inner failed');
          }),
        )
        .onComplete(() => {
          events.push('inner-complete');
        })
        .onFailure(() => {
          events.push('inner-failure');
        })
        .onSettled(() => {
          events.push('inner-settled');
        });
      const outer = new Pipeline<Ctx>('outer')
        .addStep(
          inner.asStep<Ctx>('run-inner', {
            mapInput: (ctx) => ({ k: ctx.input.n }),
          }),
        )
        .onFailure(() => {
          events.push('outer-failure');
        })
        .onSettled(() => {
          events.push('outer-settled');
        });

      const result = await outer.execute({ n: 1 });

      expect(result.ok).toBe(false);
      expect(events).toEqual([
        'inner-failure',
        'inner-settled',
        'outer-failure',
        'outer-settled',
      ]);
    });
  });

  describe('with throwOnError', () => {
    it('fires onFailure and onSettled before the PipelineError is thrown', async () => {
      const events: string[] = [];
      const pipeline = new Pipeline<Ctx>('p')
        .addStep(boom('s1'))
        .onFailure(() => {
          events.push('failure');
        })
        .onSettled(() => {
          events.push('settled');
        });

      await expect(
        pipeline.execute({ n: 1 }, { throwOnError: true }),
      ).rejects.toBeInstanceOf(PipelineError);
      expect(events).toEqual(['failure', 'settled']);
    });
  });
});
