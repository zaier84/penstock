import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { UsageError } from '../src/errors';
import type { Logger } from '../src/logger';
import { noopLogger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';

interface OrderInput {
  orderId: string;
  base?: number;
  secret?: string;
}

interface OrderCtx extends BaseContext<OrderInput> {
  total?: number;
  doubled?: number;
  token?: string;
}

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

/** A logger that records every call so tests can inspect what was (and wasn't) logged. */
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

describe('Pipeline', () => {
  describe('execution', () => {
    it('runs steps in order and threads one context by reference', async () => {
      const pipeline = new Pipeline<OrderCtx>('threading')
        .addStep(
          new Step<OrderCtx>('first', (ctx) => {
            ctx.total = (ctx.input.base ?? 0) + 5;
          }),
        )
        .addStep(
          new Step<OrderCtx>('second', (ctx) => {
            ctx.doubled = (ctx.total ?? 0) * 2;
          }),
        );

      const result = await pipeline.execute({ orderId: 'o1', base: 10 });

      expect(result.ok).toBe(true);
      expect(result.context.total).toBe(15);
      expect(result.context.doubled).toBe(30);
      expect(result.steps.map((s) => s.name)).toEqual(['first', 'second']);
      expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
    });

    it('returns the full Result shape on success', async () => {
      const pipeline = new Pipeline<OrderCtx>('shape')
        .addStep(new Step<OrderCtx>('a', () => {}))
        .addStep(new Step<OrderCtx>('b', { run: () => {}, when: () => false }));

      const result = await pipeline.execute({ orderId: 'o' });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.rollbackErrors).toEqual([]);
      expect(result.context.input.orderId).toBe('o');
      expect(result.steps).toHaveLength(2);
      expect(result.steps.map((s) => s.status)).toEqual([
        'completed',
        'skipped',
      ]);
    });

    it('resolves ok:true with empty steps for a pipeline with no steps', async () => {
      const result = await new Pipeline<OrderCtx>('empty').execute({
        orderId: 'o',
      });

      expect(result).toMatchObject({
        ok: true,
        steps: [],
        error: null,
        rollbackErrors: [],
      });
      expect(result.context.input.orderId).toBe('o');
    });

    it('populates durationMs (number >= 0 for completed, 0 for skipped)', async () => {
      const result = await new Pipeline<OrderCtx>('timing')
        .addStep(
          new Step<OrderCtx>('work', async (ctx) => {
            await Promise.resolve();
            ctx.total = 1;
          }),
        )
        .addStep(
          new Step<OrderCtx>('skip', { run: () => {}, when: () => false }),
        )
        .execute({ orderId: 'o' });

      const [done, skipped] = result.steps;
      expect(typeof done?.durationMs).toBe('number');
      expect(done?.durationMs).toBeGreaterThanOrEqual(0);
      expect(skipped?.durationMs).toBe(0);
    });
  });

  describe('guards', () => {
    it('skips a step whose guard returns false and never calls its run', async () => {
      const run = vi.fn();
      const step = new Step<OrderCtx>('maybe', { run, when: () => false });

      const result = await new Pipeline<OrderCtx>('g')
        .addStep(step)
        .execute({ orderId: 'o' });

      expect(run).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      const report = result.steps[0];
      expect(report?.status).toBe('skipped');
      expect(report?.skipReason).toBe('guard returned false');
      expect(report?.durationMs).toBe(0);
    });

    it('runs a step whose guard returns true', async () => {
      const run = vi.fn();
      const step = new Step<OrderCtx>('maybe', { run, when: () => true });

      const result = await new Pipeline<OrderCtx>('g')
        .addStep(step)
        .execute({ orderId: 'o' });

      expect(run).toHaveBeenCalledTimes(1);
      expect(result.steps[0]?.status).toBe('completed');
    });

    it('runs a step that has no guard', async () => {
      const run = vi.fn();

      const result = await new Pipeline<OrderCtx>('g')
        .addStep(new Step<OrderCtx>('always', run))
        .execute({ orderId: 'o' });

      expect(run).toHaveBeenCalledTimes(1);
      expect(result.steps[0]?.status).toBe('completed');
    });

    it('awaits an async guard', async () => {
      const run = vi.fn();
      const step = new Step<OrderCtx>('async-guard', {
        run,
        when: () => Promise.resolve(false),
      });

      const result = await new Pipeline<OrderCtx>('g')
        .addStep(step)
        .execute({ orderId: 'o' });

      expect(run).not.toHaveBeenCalled();
      expect(result.steps[0]?.status).toBe('skipped');
    });
  });

  describe('hooks', () => {
    it('fires before and after only for executed steps, in before->run->after order', async () => {
      const trail: string[] = [];
      const pipeline = new Pipeline<OrderCtx>('hooks')
        .addStep(
          new Step<OrderCtx>('run-me', () => {
            trail.push('run');
          }),
        )
        .addStep(
          new Step<OrderCtx>('skip-me', {
            run: () => {
              trail.push('skip-run');
            },
            when: () => false,
          }),
        )
        .before((_ctx, step) => {
          trail.push(`before:${step.name}`);
        })
        .after((_ctx, step) => {
          trail.push(`after:${step.name}`);
        });

      await pipeline.execute({ orderId: 'o' });

      expect(trail).toEqual(['before:run-me', 'run', 'after:run-me']);
    });

    it('runs multiple before and after hooks in registration order', async () => {
      const order: string[] = [];
      const pipeline = new Pipeline<OrderCtx>('order')
        .addStep(
          new Step<OrderCtx>('s', () => {
            order.push('run');
          }),
        )
        .before(() => {
          order.push('before-1');
        })
        .before(() => {
          order.push('before-2');
        })
        .after(() => {
          order.push('after-1');
        })
        .after(() => {
          order.push('after-2');
        });

      await pipeline.execute({ orderId: 'o' });

      expect(order).toEqual([
        'before-1',
        'before-2',
        'run',
        'after-1',
        'after-2',
      ]);
    });

    it('awaits an async before hook before running the step', async () => {
      const order: string[] = [];
      const pipeline = new Pipeline<OrderCtx>('async')
        .addStep(
          new Step<OrderCtx>('s', () => {
            order.push('run');
          }),
        )
        .before(async () => {
          await Promise.resolve();
          order.push('before-async');
        });

      await pipeline.execute({ orderId: 'o' });

      expect(order).toEqual(['before-async', 'run']);
    });

    it('passes exactly { status, durationMs } to after hooks', async () => {
      let captured: { status: string; durationMs: number } | undefined;
      const pipeline = new Pipeline<OrderCtx>('after-report')
        .addStep(new Step<OrderCtx>('s', () => {}))
        .after((_ctx, _step, report) => {
          captured = report;
        });

      await pipeline.execute({ orderId: 'o' });

      expect(captured?.status).toBe('completed');
      expect(typeof captured?.durationMs).toBe('number');
      expect(captured?.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(captured ?? {}).sort()).toEqual([
        'durationMs',
        'status',
      ]);
    });

    it('contains a synchronous before-hook throw, logs warn, keeps ok true', async () => {
      const { logger, calls } = makeCapturingLogger();
      const run = vi.fn();
      const pipeline = new Pipeline<OrderCtx>('throw-sync')
        .addStep(new Step<OrderCtx>('s', run))
        .before(() => {
          throw new Error('hook boom');
        })
        .before(() => {});

      const result = await pipeline.execute({ orderId: 'o' }, { logger });

      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      const warns = calls.filter((c) => c.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.meta).toMatchObject({
        hook: 'before',
        stepName: 's',
        errorType: 'Error',
        errorMessage: 'hook boom',
      });
    });

    it('contains an async before-hook rejection with a non-Error value', async () => {
      const { logger, calls } = makeCapturingLogger();
      const order: string[] = [];
      const pipeline = new Pipeline<OrderCtx>('throw-async')
        .addStep(
          new Step<OrderCtx>('s', () => {
            order.push('run');
          }),
        )
        .before(async () => {
          await Promise.resolve();
          throw 'string-failure';
        })
        .before(() => {
          order.push('before-2');
        });

      const result = await pipeline.execute({ orderId: 'o' }, { logger });

      expect(result.ok).toBe(true);
      expect(order).toEqual(['before-2', 'run']);
      const warn = calls.find((c) => c.level === 'warn');
      expect(warn?.meta).toMatchObject({
        errorType: 'string',
        errorMessage: 'string-failure',
      });
    });

    it('contains an after-hook throw', async () => {
      const { logger, calls } = makeCapturingLogger();
      const pipeline = new Pipeline<OrderCtx>('after-throw')
        .addStep(new Step<OrderCtx>('s', () => {}))
        .after(() => {
          throw new Error('after boom');
        });

      const result = await pipeline.execute({ orderId: 'o' }, { logger });

      expect(result.ok).toBe(true);
      expect(
        calls.some((c) => c.level === 'warn' && c.meta?.hook === 'after'),
      ).toBe(true);
    });
  });

  describe('log hygiene (§1.10)', () => {
    it('never passes input or context values to the logger', async () => {
      const { logger, calls } = makeCapturingLogger();
      const SECRET_INPUT = 'super-secret-input-value';
      const SECRET_CTX = 'super-secret-ctx-value';
      const pipeline = new Pipeline<OrderCtx>('hygiene')
        .addStep(
          new Step<OrderCtx>('writes-secret', (ctx) => {
            ctx.token = SECRET_CTX;
          }),
        )
        .addStep(
          new Step<OrderCtx>('skipped', { run: () => {}, when: () => false }),
        )
        .before(() => {})
        .after(() => {});

      await pipeline.execute(
        { orderId: 'o', secret: SECRET_INPUT },
        { logger },
      );

      const serialized = JSON.stringify(calls);
      expect(serialized).not.toContain(SECRET_INPUT);
      expect(serialized).not.toContain(SECRET_CTX);
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  describe('synchronous validation', () => {
    it('rejects addStep with a non-Step', () => {
      const pipeline = new Pipeline<OrderCtx>('v');
      expect(() =>
        pipeline.addStep({ name: 'x' } as unknown as Step<OrderCtx>),
      ).toThrow(UsageError);
    });

    it('rejects a duplicate step name', () => {
      const pipeline = new Pipeline<OrderCtx>('v').addStep(
        new Step<OrderCtx>('dup', () => {}),
      );
      expect(() =>
        pipeline.addStep(new Step<OrderCtx>('dup', () => {})),
      ).toThrow(UsageError);
    });

    it('rejects an empty or non-string pipeline name', () => {
      expect(() => new Pipeline<OrderCtx>('')).toThrow(UsageError);
      expect(() => new Pipeline<OrderCtx>(123 as unknown as string)).toThrow(
        UsageError,
      );
    });

    it.each(['__proto__', 'prototype', 'constructor'])(
      'rejects the reserved pipeline name %s',
      (name) => {
        expect(() => new Pipeline<OrderCtx>(name)).toThrow(UsageError);
      },
    );
  });

  describe('re-entrancy', () => {
    const buildPipeline = () =>
      new Pipeline<OrderCtx>('reentrant').addStep(
        new Step<OrderCtx>('compute', async (ctx) => {
          await Promise.resolve();
          ctx.total = (ctx.input.base ?? 0) * 2;
        }),
      );

    it('produces independent results when executed twice sequentially', async () => {
      const pipeline = buildPipeline();
      const r1 = await pipeline.execute({ orderId: 'a', base: 1 });
      const r2 = await pipeline.execute({ orderId: 'b', base: 5 });

      expect(r1.context.total).toBe(2);
      expect(r2.context.total).toBe(10);
      expect(r1.context).not.toBe(r2.context);
    });

    it('produces independent results when executed concurrently', async () => {
      const pipeline = buildPipeline();
      const [r1, r2] = await Promise.all([
        pipeline.execute({ orderId: 'a', base: 3 }),
        pipeline.execute({ orderId: 'b', base: 7 }),
      ]);

      expect(r1.context.total).toBe(6);
      expect(r2.context.total).toBe(14);
      expect(r1.context).not.toBe(r2.context);
      expect(r1.steps).not.toBe(r2.steps);
    });
  });

  describe('logger', () => {
    it('defaults to noopLogger and exposes it on ctx.logger', async () => {
      let seen: Logger | undefined;
      const result = await new Pipeline<OrderCtx>('log')
        .addStep(
          new Step<OrderCtx>('s', (ctx) => {
            seen = ctx.logger;
          }),
        )
        .execute({ orderId: 'o' });

      expect(seen).toBe(noopLogger);
      expect(result.context.logger).toBe(noopLogger);
    });

    it('injects a custom logger and threads it on ctx.logger', async () => {
      const { logger, calls } = makeCapturingLogger();
      let seen: Logger | undefined;
      await new Pipeline<OrderCtx>('log')
        .addStep(
          new Step<OrderCtx>('s', (ctx) => {
            seen = ctx.logger;
          }),
        )
        .execute({ orderId: 'o' }, { logger });

      expect(seen).toBe(logger);
      expect(calls.some((c) => c.level === 'debug')).toBe(true);
    });
  });

  describe('builder', () => {
    it('returns the pipeline from every builder method (chainable)', () => {
      const pipeline = new Pipeline<OrderCtx>('chain');
      expect(pipeline.addStep(new Step<OrderCtx>('s', () => {}))).toBe(
        pipeline,
      );
      expect(pipeline.before(() => {})).toBe(pipeline);
      expect(pipeline.after(() => {})).toBe(pipeline);
      expect(pipeline.onError(() => {})).toBe(pipeline);
    });

    it('does not fire onError on a successful run', async () => {
      const onError = vi.fn();
      const result = await new Pipeline<OrderCtx>('no-error')
        .addStep(new Step<OrderCtx>('s', () => {}))
        .onError(onError)
        .execute({ orderId: 'o' });

      expect(result.ok).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
