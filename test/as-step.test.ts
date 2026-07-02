import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { Engine, clearEngines, registerEngine } from '../src/engine';
import { StepError, UsageError } from '../src/errors';
import type { Logger } from '../src/logger';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { AsStepOptions, Result, StepReport } from '../src/types';

interface OrderInput {
  orderId: string;
  amounts: number[];
}

interface OuterCtx extends BaseContext<OrderInput> {
  total?: number;
  echo?: unknown;
}

interface InvInput {
  items: number[];
}

interface InnerCtx extends BaseContext<InvInput> {
  reserved?: number;
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
function report<C extends BaseContext>(
  result: Result<C>,
  name: string,
): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

/** The standard mapInput used across tests: inner reserves the order amounts. */
const toInvInput = (outer: OuterCtx): InvInput => ({
  items: outer.input.amounts,
});

// One test registers a global engine (process-wide state, section 3.5).
afterEach(() => {
  clearEngines();
});

describe('Pipeline.asStep (0.3.0 section 1.2)', () => {
  describe('basic execution', () => {
    it('completes the wrapping step on inner success, calls mapResult, and attaches innerResult', async () => {
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', (ctx) => {
          ctx.reserved = ctx.input.items.length;
        }),
      );
      let seenInner: Result<InnerCtx> | undefined;
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', {
            mapInput: toInvInput,
            mapResult: (innerResult, outerCtx) => {
              seenInner = innerResult as Result<InnerCtx>;
              outerCtx.total = (
                innerResult as Result<InnerCtx>
              ).context.reserved;
            },
          }),
        )
        .addStep(new Step<OuterCtx>('confirm', () => {}));

      const result = await outer.execute({ orderId: 'o', amounts: [5, 7] });

      expect(result.ok).toBe(true);
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('completed');
      // mapResult ran with the inner Result and the outer context.
      expect(seenInner?.ok).toBe(true);
      expect(result.context.total).toBe(2);
      // The same inner Result object surfaces on the wrapping report.
      expect(wrap.innerResult).toBe(seenInner);
      expect(wrap.innerResult?.steps.map((s) => s.name)).toEqual(['reserve']);
      // Other steps never carry innerResult (section 1.2.5).
      expect(report(result, 'confirm').innerResult).toBeUndefined();
    });

    it('fails the wrapping step on inner failure without calling mapResult, and rolls back prior outer steps', async () => {
      const rawInner = new Error('stock exploded');
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', () => {
          throw rawInner;
        }),
      );
      const mapResult = vi.fn();
      const undoPrior = vi.fn();
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          new Step<OuterCtx>('prior', { run: () => {}, undo: undoPrior }),
        )
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', {
            mapInput: toInvInput,
            mapResult,
          }),
        );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      expect(mapResult).not.toHaveBeenCalled();
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('failed');
      // innerResult shows the inner failure in full detail.
      expect(wrap.innerResult?.ok).toBe(false);
      expect(
        report(wrap.innerResult as Result<InnerCtx>, 'reserve').status,
      ).toBe('failed');
      // The causal chain: outer StepError -> inner result.error -> raw cause.
      expect(result.error).toBeInstanceOf(StepError);
      expect((result.error as StepError).stepName).toBe('run-inventory');
      const innerError = (result.error as StepError).cause as StepError;
      expect(innerError).toBe(wrap.innerResult?.error);
      expect(innerError.cause).toBe(rawInner);
      // Outer rollback ran for the prior step.
      expect(undoPrior).toHaveBeenCalledTimes(1);
      expect(report(result, 'prior').status).toBe('rolled-back');
    });
  });

  describe('rollback interaction (section 1.2.4)', () => {
    it('scenario A: a failing inner pipeline rolls itself back; the outer never re-runs inner undos', async () => {
      const innerUndo = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory')
        .addStep(
          new Step<InnerCtx>('reserve', { run: () => {}, undo: innerUndo }),
        )
        .addStep(
          new Step<InnerCtx>('boom', () => {
            throw new Error('inner fail');
          }),
        );
      const outer = new Pipeline<OuterCtx>('order').addStep(
        inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
      );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      // Exactly once: by the inner pipeline's own rollback, inside execute.
      expect(innerUndo).toHaveBeenCalledTimes(1);
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('failed');
      expect(
        report(wrap.innerResult as Result<InnerCtx>, 'reserve').status,
      ).toBe('rolled-back');
    });

    it('scenario B with undo: outer rollback calls the user undo; the inner pipeline is not re-rolled-back', async () => {
      const innerUndo = vi.fn();
      const wrapUndo = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', { run: () => {}, undo: innerUndo }),
      );
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', {
            mapInput: toInvInput,
            undo: wrapUndo,
          }),
        )
        .addStep(
          new Step<OuterCtx>('charge', () => {
            throw new Error('payment declined');
          }),
        );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      expect(report(result, 'run-inventory').status).toBe('rolled-back');
      // Only the user-provided compensation ran, with the OUTER context.
      expect(wrapUndo).toHaveBeenCalledTimes(1);
      expect(wrapUndo.mock.calls[0]?.[0]).toBe(result.context);
      // The inner pipeline's work is committed; its undos never re-run.
      expect(innerUndo).not.toHaveBeenCalled();
    });

    it('scenario B without undo: the wrapping step stays completed through outer rollback', async () => {
      const innerUndo = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', { run: () => {}, undo: innerUndo }),
      );
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
        )
        .addStep(
          new Step<OuterCtx>('charge', () => {
            throw new Error('payment declined');
          }),
        );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      expect(report(result, 'run-inventory').status).toBe('completed');
      expect(innerUndo).not.toHaveBeenCalled();
      expect(result.rollbackErrors).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('runs the inner pipeline on its own fresh context derived via mapInput', async () => {
      let innerCtx: InnerCtx | undefined;
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('capture', (ctx) => {
          innerCtx = ctx;
        }),
      );
      const outer = new Pipeline<OuterCtx>('order').addStep(
        inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
      );

      const result = await outer.execute({ orderId: 'o', amounts: [3, 4] });

      expect(result.ok).toBe(true);
      // A distinct context object, not the outer one (section 1.2.2). Compared
      // via Object.is: an equality walk would probe the engine accessor proxy,
      // which throws on unknown names by design (section 3.5).
      expect(innerCtx).toBeDefined();
      expect(Object.is(innerCtx, result.context)).toBe(false);
      // Its input is what mapInput derived, not the outer input.
      expect(innerCtx?.input).toEqual({ items: [3, 4] });
      expect(result.context.input).toEqual({ orderId: 'o', amounts: [3, 4] });
    });

    it("does not expose the outer pipeline's scoped engines to the inner pipeline", async () => {
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('use-engine', (ctx) => {
          void ctx.engines['outer-only'];
        }),
      );
      const outer = new Pipeline<OuterCtx>('order')
        .useEngine(new Engine('outer-only', { m() {} }))
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
        );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      // The inner lookup failed: outer-scoped engines do not leak inward.
      expect(result.ok).toBe(false);
      const innerError = (result.error as StepError).cause as StepError;
      expect(innerError.cause).toBeInstanceOf(UsageError);
      expect((innerError.cause as Error).message).toContain('outer-only');
    });

    it('resolves inner engines from its own useEngine registrations and the global registry', async () => {
      registerEngine(
        new Engine('global-math', {
          double(n: number) {
            return n * 2;
          },
        }),
      );
      const inner = new Pipeline<InnerCtx>('inventory')
        .useEngine(
          new Engine('local-math', {
            inc(n: number) {
              return n + 1;
            },
          }),
        )
        .addStep(
          new Step<InnerCtx>('compute', (ctx) => {
            const doubled = ctx.engines['global-math']!.double!(10) as number;
            ctx.reserved = ctx.engines['local-math']!.inc!(doubled) as number;
          }),
        );
      const outer = new Pipeline<OuterCtx>('order').addStep(
        inner.asStep<OuterCtx>('run-inventory', {
          mapInput: toInvInput,
          mapResult: (innerResult, outerCtx) => {
            outerCtx.total = (innerResult as Result<InnerCtx>).context.reserved;
          },
        }),
      );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(true);
      expect(result.context.total).toBe(21);
    });

    it("forwards the outer run's logger to the inner pipeline", async () => {
      const { logger, calls } = makeCapturingLogger();
      let innerLogger: Logger | undefined;
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('capture', (ctx) => {
          innerLogger = ctx.logger;
        }),
      );
      const outer = new Pipeline<OuterCtx>('order').addStep(
        inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
      );

      await outer.execute({ orderId: 'o', amounts: [1] }, { logger });

      expect(innerLogger).toBe(logger);
      // Inner lifecycle logs flow to the same destination as outer ones.
      expect(
        calls.some(
          (c) => c.level === 'debug' && c.meta?.stepName === 'capture',
        ),
      ).toBe(true);
    });
  });

  describe('signal propagation (section 1.2.4, scenario C)', () => {
    it('propagates an outer cancel into the inner pipeline, which rolls back; the outer reports a cancellation', async () => {
      const controller = new AbortController();
      const reason = new Error('order cancelled');
      const innerUndo = vi.fn();
      const outerUndo = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory')
        .addStep(
          new Step<InnerCtx>('reserve', { run: () => {}, undo: innerUndo }),
        )
        .addStep(
          new Step<InnerCtx>('wait', {
            run: (ctx) =>
              new Promise<void>((_resolve, reject) => {
                ctx.signal.addEventListener(
                  'abort',
                  () => reject(ctx.signal.reason),
                  { once: true },
                );
                // Fire the OUTER cancel while the inner pipeline is mid-run.
                setTimeout(() => controller.abort(reason), 0);
              }),
          }),
        );
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          new Step<OuterCtx>('prior', { run: () => {}, undo: outerUndo }),
        )
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', { mapInput: toInvInput }),
        )
        .addStep(new Step<OuterCtx>('later', () => {}));

      const result = await outer.execute(
        { orderId: 'o', amounts: [1] },
        { signal: controller.signal },
      );

      // The outer run is a cancellation: raw reason, aborted flag set.
      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.error).toBe(reason);
      // The inner pipeline handled the cancel internally: completed inner
      // steps rolled back, its own Result marked aborted.
      expect(innerUndo).toHaveBeenCalledTimes(1);
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('skipped');
      expect(wrap.skipReason).toBe('cancelled');
      expect(wrap.innerResult?.aborted).toBe(true);
      expect(
        report(wrap.innerResult as Result<InnerCtx>, 'reserve').status,
      ).toBe('rolled-back');
      // Outer rollback ran for prior steps; later steps are cancelled.
      expect(outerUndo).toHaveBeenCalledTimes(1);
      expect(report(result, 'prior').status).toBe('rolled-back');
      expect(report(result, 'later').status).toBe('skipped');
      expect(report(result, 'later').skipReason).toBe('cancelled');
    });
  });

  describe('guard', () => {
    it('skips the wrapping step when the when option is falsy, never touching the inner pipeline', async () => {
      const mapInput = vi.fn(toInvInput);
      const innerRun = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', innerRun),
      );
      const outer = new Pipeline<OuterCtx>('order').addStep(
        inner.asStep<OuterCtx>('run-inventory', {
          mapInput,
          when: (ctx) => ctx.input.amounts.length > 0,
        }),
      );

      const result = await outer.execute({ orderId: 'o', amounts: [] });

      expect(result.ok).toBe(true);
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('skipped');
      expect(wrap.skipReason).toBe('guard returned false');
      expect(wrap.innerResult).toBeUndefined();
      expect(mapInput).not.toHaveBeenCalled();
      expect(innerRun).not.toHaveBeenCalled();
    });

    it('returns a regular Step usable with .when() and addStep', async () => {
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', () => {}),
      );
      const wrapped = inner.asStep<OuterCtx>('run-inventory', {
        mapInput: toInvInput,
      });
      expect(wrapped).toBeInstanceOf(Step);

      // The fluent guard clone works exactly like any other Step's.
      const guarded = wrapped.when(() => false);
      const result = await new Pipeline<OuterCtx>('order')
        .addStep(guarded)
        .execute({ orderId: 'o', amounts: [1] });

      expect(report(result, 'run-inventory').status).toBe('skipped');
    });
  });

  describe('mapInput validation', () => {
    it('throws a UsageError synchronously when mapInput is missing', () => {
      const inner = new Pipeline<InnerCtx>('inventory');
      expect(() =>
        inner.asStep<OuterCtx>(
          'run-inventory',
          {} as AsStepOptions<OuterCtx, InvInput>,
        ),
      ).toThrow(UsageError);
    });

    it('fails the wrapping step when mapInput throws, and rolls back prior steps', async () => {
      const raw = new Error('cannot derive input');
      const undoPrior = vi.fn();
      const innerRun = vi.fn();
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', innerRun),
      );
      const outer = new Pipeline<OuterCtx>('order')
        .addStep(
          new Step<OuterCtx>('prior', { run: () => {}, undo: undoPrior }),
        )
        .addStep(
          inner.asStep<OuterCtx>('run-inventory', {
            mapInput: () => {
              throw raw;
            },
          }),
        );

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      const wrap = report(result, 'run-inventory');
      expect(wrap.status).toBe('failed');
      expect((result.error as StepError).cause).toBe(raw);
      // The inner pipeline never started, so there is no innerResult.
      expect(wrap.innerResult).toBeUndefined();
      expect(innerRun).not.toHaveBeenCalled();
      expect(undoPrior).toHaveBeenCalledTimes(1);
    });
  });

  describe('nested in a parallel group (section 1.2.6)', () => {
    it('runs two inner pipelines concurrently inside addParallel', async () => {
      const sleepStep = (name: string) =>
        new Step<InnerCtx>(name, () => {
          return new Promise<void>((resolve) => setTimeout(resolve, 50));
        });
      const innerA = new Pipeline<InnerCtx>('inv-a').addStep(sleepStep('a1'));
      const innerB = new Pipeline<InnerCtx>('inv-b').addStep(sleepStep('b1'));
      const outer = new Pipeline<OuterCtx>('order').addParallel([
        innerA.asStep<OuterCtx>('wrap-a', { mapInput: toInvInput }),
        innerB.asStep<OuterCtx>('wrap-b', { mapInput: toInvInput }),
      ]);

      const start = performance.now();
      const result = await outer.execute({ orderId: 'o', amounts: [1] });
      const elapsed = performance.now() - start;

      expect(result.ok).toBe(true);
      expect(report(result, 'wrap-a').status).toBe('completed');
      expect(report(result, 'wrap-b').status).toBe('completed');
      expect(report(result, 'wrap-a').innerResult?.ok).toBe(true);
      expect(report(result, 'wrap-b').innerResult?.ok).toBe(true);
      // Two 50ms inner pipelines in parallel finish in ~50ms, not ~100ms.
      expect(elapsed).toBeLessThan(95);
    });

    it('cancels the sibling inner pipeline when one inner fails, rolling back its completed steps', async () => {
      const innerAUndo = vi.fn();
      const innerBUndo = vi.fn();
      const innerA = new Pipeline<InnerCtx>('inv-a')
        .addStep(new Step<InnerCtx>('a1', { run: () => {}, undo: innerAUndo }))
        .addStep(
          new Step<InnerCtx>('a2', () => {
            throw new Error('inner a failed');
          }),
        );
      const innerB = new Pipeline<InnerCtx>('inv-b')
        .addStep(new Step<InnerCtx>('b1', { run: () => {}, undo: innerBUndo }))
        .addStep(
          new Step<InnerCtx>('b2', {
            // Cooperative: settles only when the propagated group abort lands.
            run: (ctx) =>
              new Promise<void>((_resolve, reject) => {
                ctx.signal.addEventListener(
                  'abort',
                  () => reject(ctx.signal.reason),
                  { once: true },
                );
              }),
          }),
        );
      const outer = new Pipeline<OuterCtx>('order').addParallel([
        innerA.asStep<OuterCtx>('wrap-a', { mapInput: toInvInput }),
        innerB.asStep<OuterCtx>('wrap-b', { mapInput: toInvInput }),
      ]);

      const result = await outer.execute({ orderId: 'o', amounts: [1] });

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      // wrap-a failed for real; its inner rolled itself back (scenario A).
      expect(report(result, 'wrap-a').status).toBe('failed');
      expect(innerAUndo).toHaveBeenCalledTimes(1);
      expect((result.error as StepError).stepName).toBe('wrap-a');
      // wrap-b was cancelled by the group abort; its inner pipeline saw the
      // propagated signal, stopped, and rolled back its completed step.
      const wrapB = report(result, 'wrap-b');
      expect(wrapB.status).toBe('skipped');
      expect(wrapB.skipReason).toBe('cancelled (parallel peer failed)');
      expect(innerBUndo).toHaveBeenCalledTimes(1);
      expect(wrapB.innerResult?.aborted).toBe(true);
      expect(report(wrapB.innerResult as Result<InnerCtx>, 'b1').status).toBe(
        'rolled-back',
      );
    });
  });

  describe('name validation', () => {
    it('rejects an empty name with a UsageError', () => {
      const inner = new Pipeline<InnerCtx>('inventory');
      expect(() =>
        inner.asStep<OuterCtx>('', { mapInput: toInvInput }),
      ).toThrow(UsageError);
    });

    it.each(['__proto__', 'prototype', 'constructor'])(
      'rejects the reserved name "%s"',
      (name) => {
        const inner = new Pipeline<InnerCtx>('inventory');
        expect(() =>
          inner.asStep<OuterCtx>(name, { mapInput: toInvInput }),
        ).toThrow(UsageError);
      },
    );
  });
});
