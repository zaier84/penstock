import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { PipelineError, StepError } from '../src/errors';
import type { Logger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';

interface OrderInput {
  orderId: string;
}

interface OrderCtx extends BaseContext<OrderInput> {
  total?: number;
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

/** Looks up a step report by name (reports carry unique names within a pipeline). */
function status(
  result: { steps: { name: string; status: string }[] },
  name: string,
): string | undefined {
  return result.steps.find((s) => s.name === name)?.status;
}

describe('Pipeline rollback & error handling (§1.7)', () => {
  describe('step failure', () => {
    it('marks the failing step failed and never runs later steps', async () => {
      const later = vi.fn();
      const result = await new Pipeline<OrderCtx>('abort')
        .addStep(new Step<OrderCtx>('ok', () => {}))
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('kaboom');
          }),
        )
        .addStep(new Step<OrderCtx>('later', later))
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(later).not.toHaveBeenCalled();
      // 'later' never executed, so it gets no report at all.
      expect(result.steps.map((s) => s.name)).toEqual(['ok', 'boom']);
      expect(status(result, 'boom')).toBe('failed');
    });

    it('wraps the thrown error in a StepError shared by result.error and the report', async () => {
      const raw = new Error('inventory exploded');
      const result = await new Pipeline<OrderCtx>('wrap')
        .addStep(
          new Step<OrderCtx>('reserve', () => {
            throw raw;
          }),
        )
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(StepError);
      const stepError = result.error as StepError;
      expect(stepError.stepName).toBe('reserve');
      expect(stepError.cause).toBe(raw);
      const report = result.steps.find((s) => s.name === 'reserve');
      expect(report?.status).toBe('failed');
      // The same StepError instance populates both places.
      expect(report?.error).toBe(result.error);
    });

    it('treats a throwing guard as a step failure and never calls run', async () => {
      const run = vi.fn();
      const undoA = vi.fn();
      const result = await new Pipeline<OrderCtx>('guard-throw')
        .addStep(new Step<OrderCtx>('a', { run: () => {}, undo: undoA }))
        .addStep(
          new Step<OrderCtx>('guarded', {
            run,
            when: () => {
              throw new Error('guard exploded');
            },
          }),
        )
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
      const report = result.steps.find((s) => s.name === 'guarded');
      expect(report?.status).toBe('failed');
      expect(report?.error).toBeInstanceOf(StepError);
      expect((report?.error as StepError).cause).toBeInstanceOf(Error);
      // A prior completed step with an undo is still compensated.
      expect(undoA).toHaveBeenCalledTimes(1);
      expect(status(result, 'a')).toBe('rolled-back');
    });
  });

  describe('rollback', () => {
    it('compensates completed steps in reverse order', async () => {
      const trail: string[] = [];
      const mk = (name: string) =>
        new Step<OrderCtx>(name, {
          run: () => {
            trail.push(`run:${name}`);
          },
          undo: () => {
            trail.push(`undo:${name}`);
          },
        });
      const result = await new Pipeline<OrderCtx>('reverse')
        .addStep(mk('a'))
        .addStep(mk('b'))
        .addStep(
          new Step<OrderCtx>('c', () => {
            throw new Error('c failed');
          }),
        )
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(trail).toEqual(['run:a', 'run:b', 'undo:b', 'undo:a']);
      expect(status(result, 'a')).toBe('rolled-back');
      expect(status(result, 'b')).toBe('rolled-back');
      expect(status(result, 'c')).toBe('failed');
      expect(result.rollbackErrors).toEqual([]);
    });

    it('leaves a completed step without an undo as completed', async () => {
      const result = await new Pipeline<OrderCtx>('no-undo')
        .addStep(new Step<OrderCtx>('plain', () => {}))
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('x');
          }),
        )
        .execute({ orderId: 'o' });

      expect(status(result, 'plain')).toBe('completed');
      expect(result.rollbackErrors).toEqual([]);
    });

    it('handles a first-step failure with nothing to roll back', async () => {
      const never = vi.fn();
      const result = await new Pipeline<OrderCtx>('first-fail')
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('immediate');
          }),
        )
        .addStep(new Step<OrderCtx>('never', never))
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(never).not.toHaveBeenCalled();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.status).toBe('failed');
      expect(result.rollbackErrors).toEqual([]);
    });

    it('rolls back nothing when no completed step declares an undo', async () => {
      const result = await new Pipeline<OrderCtx>('no-undoable')
        .addStep(new Step<OrderCtx>('a', () => {}))
        .addStep(new Step<OrderCtx>('b', () => {}))
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('x');
          }),
        )
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(false);
      expect(result.rollbackErrors).toEqual([]);
      expect(
        result.steps.filter((s) => s.status === 'completed').map((s) => s.name),
      ).toEqual(['a', 'b']);
    });
  });

  describe('undo failures', () => {
    it('marks a throwing undo rollback-failed, collects it, and still runs the rest', async () => {
      const { logger, calls } = makeCapturingLogger();
      const trail: string[] = [];
      const undoErr = new Error('undo b failed');
      const result = await new Pipeline<OrderCtx>('undo-throw')
        .addStep(
          new Step<OrderCtx>('a', {
            run: () => {},
            undo: () => {
              trail.push('undo:a');
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('b', {
            run: () => {},
            undo: () => {
              trail.push('undo:b');
              throw undoErr;
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('c');
          }),
        )
        .execute({ orderId: 'o' }, { logger });

      // Reverse order: b's undo throws, a's undo still runs.
      expect(trail).toEqual(['undo:b', 'undo:a']);
      expect(status(result, 'b')).toBe('rollback-failed');
      expect(result.steps.find((s) => s.name === 'b')?.error).toBe(undoErr);
      expect(status(result, 'a')).toBe('rolled-back');
      expect(result.rollbackErrors).toEqual([undoErr]);
      const errorLog = calls.find(
        (c) => c.level === 'error' && c.meta?.status === 'rollback-failed',
      );
      expect(errorLog?.meta).toMatchObject({
        stepName: 'b',
        errorType: 'Error',
        errorMessage: 'undo b failed',
      });
    });

    it('collects multiple throwing undos and logs each at error', async () => {
      const { logger, calls } = makeCapturingLogger();
      const eA = new Error('undo a');
      const eB = new Error('undo b');
      const result = await new Pipeline<OrderCtx>('multi-undo')
        .addStep(
          new Step<OrderCtx>('a', {
            run: () => {},
            undo: () => {
              throw eA;
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('b', {
            run: () => {},
            undo: () => {
              throw eB;
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('c');
          }),
        )
        .execute({ orderId: 'o' }, { logger });

      // Reverse order: b collected before a.
      expect(result.rollbackErrors).toEqual([eB, eA]);
      expect(status(result, 'a')).toBe('rollback-failed');
      expect(status(result, 'b')).toBe('rollback-failed');
      expect(
        calls.filter(
          (c) => c.level === 'error' && c.meta?.status === 'rollback-failed',
        ),
      ).toHaveLength(2);
    });

    it('coerces a non-Error undo throw into an Error in result.rollbackErrors', async () => {
      const result = await new Pipeline<OrderCtx>('non-error-undo')
        .addStep(
          new Step<OrderCtx>('a', {
            run: () => {},
            undo: () => {
              throw 'string-undo-failure';
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('c');
          }),
        )
        .execute({ orderId: 'o' });

      expect(result.rollbackErrors).toHaveLength(1);
      expect(result.rollbackErrors[0]).toBeInstanceOf(Error);
      expect(result.rollbackErrors[0]?.message).toBe('string-undo-failure');
      expect(status(result, 'a')).toBe('rollback-failed');
    });
  });

  describe('onError hook', () => {
    it('fires once, before rollback begins', async () => {
      const trail: string[] = [];
      const onError = vi.fn(() => {
        trail.push('onError');
      });
      await new Pipeline<OrderCtx>('on-error-order')
        .addStep(
          new Step<OrderCtx>('a', {
            run: () => {},
            undo: () => {
              trail.push('undo:a');
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('x');
          }),
        )
        .onError(onError)
        .execute({ orderId: 'o' });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(trail).toEqual(['onError', 'undo:a']);
    });

    it('passes the StepError, context, and failing step to onError', async () => {
      const raw = new Error('boom');
      const failing = new Step<OrderCtx>('boom', () => {
        throw raw;
      });
      let args: [Error, OrderCtx, Step<OrderCtx>] | undefined;
      const result = await new Pipeline<OrderCtx>('on-error-args')
        .addStep(failing)
        .onError((err, ctx, step) => {
          args = [err, ctx, step];
        })
        .execute({ orderId: 'o' });

      expect(args?.[0]).toBeInstanceOf(StepError);
      expect(args?.[0]).toBe(result.error);
      expect((args?.[0] as StepError).cause).toBe(raw);
      expect(args?.[1]).toBe(result.context);
      expect(args?.[2]).toBe(failing);
    });

    it('contains a throwing onError hook, logs at error, and still rolls back', async () => {
      const { logger, calls } = makeCapturingLogger();
      const undo = vi.fn();
      const result = await new Pipeline<OrderCtx>('on-error-throw')
        .addStep(new Step<OrderCtx>('a', { run: () => {}, undo }))
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('x');
          }),
        )
        .onError(() => {
          throw new Error('hook boom');
        })
        .execute({ orderId: 'o' }, { logger });

      // The hook throw never alters ok and never blocks rollback (§1.8).
      expect(result.ok).toBe(false);
      expect(undo).toHaveBeenCalledTimes(1);
      expect(status(result, 'a')).toBe('rolled-back');
      const hookLog = calls.find(
        (c) => c.level === 'error' && c.meta?.hook === 'onError',
      );
      expect(hookLog?.meta).toMatchObject({
        hook: 'onError',
        stepName: 'boom',
        errorType: 'Error',
        errorMessage: 'hook boom',
      });
    });
  });

  describe('throwOnError', () => {
    it('throws a PipelineError carrying the result and originating cause', async () => {
      const raw = new Error('boom');
      const pipeline = new Pipeline<OrderCtx>('throw-on-error')
        .addStep(new Step<OrderCtx>('a', { run: () => {}, undo: () => {} }))
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw raw;
          }),
        );

      let caught: PipelineError<OrderCtx> | undefined;
      try {
        await pipeline.execute({ orderId: 'o' }, { throwOnError: true });
      } catch (e) {
        caught = e as PipelineError<OrderCtx>;
      }

      expect(caught).toBeInstanceOf(PipelineError);
      expect(caught?.result.ok).toBe(false);
      expect(caught?.cause).toBeInstanceOf(StepError);
      expect(caught?.cause).toBe(caught?.result.error);
      expect((caught?.cause as StepError).cause).toBe(raw);
      // No undo failed, so no AggregateError is attached.
      expect(caught?.rollbackErrors).toBeUndefined();
      expect(caught?.result.steps.find((s) => s.name === 'a')?.status).toBe(
        'rolled-back',
      );
    });

    it('bundles undo failures into an AggregateError on the thrown error', async () => {
      const undoErr = new Error('undo failed');
      const pipeline = new Pipeline<OrderCtx>('throw-agg')
        .addStep(
          new Step<OrderCtx>('a', {
            run: () => {},
            undo: () => {
              throw undoErr;
            },
          }),
        )
        .addStep(
          new Step<OrderCtx>('boom', () => {
            throw new Error('x');
          }),
        );

      let caught: PipelineError<OrderCtx> | undefined;
      try {
        await pipeline.execute({ orderId: 'o' }, { throwOnError: true });
      } catch (e) {
        caught = e as PipelineError<OrderCtx>;
      }

      expect(caught?.rollbackErrors).toBeInstanceOf(AggregateError);
      expect(caught?.rollbackErrors?.errors).toEqual([undoErr]);
    });
  });
});
