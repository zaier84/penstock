import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepMeta, StepReport } from '../src/types';

interface OrderInput {
  orderId: string;
}

interface Ctx extends BaseContext<OrderInput> {
  charged?: boolean;
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report(result: Result<Ctx>, name: string): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

const input: OrderInput = { orderId: 'ord_1' };

describe('idempotency keys (section 1.4)', () => {
  describe('default key', () => {
    it('is `${executionId}:${stepName}` and is reported on the step', async () => {
      let meta: StepMeta | undefined;
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', (_ctx, m) => {
            meta = m;
          }),
        )
        .execute(input);

      expect(meta?.idempotencyKey).toBe(`${result.executionId}:charge`);
      expect(report(result, 'charge').idempotencyKey).toBe(
        meta?.idempotencyKey,
      );
    });

    it('differs between two executions of the same pipeline', async () => {
      const keys: string[] = [];
      const pipeline = new Pipeline<Ctx>('orders').addStep(
        new Step<Ctx>('charge', (_ctx, meta) => {
          keys.push(meta.idempotencyKey);
        }),
      );

      await pipeline.execute(input);
      await pipeline.execute(input);

      expect(keys).toHaveLength(2);
      // The executionId component makes each run distinct.
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('gives each step of a parallel group its own key', async () => {
      const keys: string[] = [];
      const capture = (_ctx: Ctx, meta: StepMeta): void => {
        keys.push(meta.idempotencyKey);
      };
      const result = await new Pipeline<Ctx>('orders')
        .addParallel([
          new Step<Ctx>('left', capture),
          new Step<Ctx>('right', capture),
        ])
        .execute(input);

      expect(keys.sort()).toEqual([
        `${result.executionId}:left`,
        `${result.executionId}:right`,
      ]);
    });
  });

  describe('stability across attempts', () => {
    it('reuses one key for every attempt of a retried step', async () => {
      const keys: string[] = [];
      let calls = 0;
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: (_ctx, meta) => {
              keys.push(meta.idempotencyKey);
              calls += 1;
              if (calls < 3) throw new Error(`attempt-${calls}`);
            },
            retry: { attempts: 3, delayMs: 0 },
          }),
        )
        .execute(input);

      expect(result.ok).toBe(true);
      expect(keys).toHaveLength(3);
      // The whole point: the downstream service sees one logical operation.
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe(`${result.executionId}:charge`);
      expect(report(result, 'charge').idempotencyKey).toBe(keys[0]);
    });
  });

  describe('undo key', () => {
    it('is the run key plus ":undo"', async () => {
      let runKey: string | undefined;
      let undoKey: string | undefined;
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: (_ctx, meta) => {
              runKey = meta.idempotencyKey;
            },
            undo: (_ctx, meta) => {
              undoKey = meta.idempotencyKey;
            },
          }),
        )
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('later failure');
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      expect(runKey).toBe(`${result.executionId}:charge`);
      expect(undoKey).toBe(`${runKey}:undo`);
    });
  });

  describe('string override', () => {
    it('uses the string verbatim and appends ":undo" for the compensation', async () => {
      let runKey: string | undefined;
      let undoKey: string | undefined;
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: (_ctx, meta) => {
              runKey = meta.idempotencyKey;
            },
            undo: (_ctx, meta) => {
              undoKey = meta.idempotencyKey;
            },
            idempotencyKey: 'charge-fixed-key',
          }),
        )
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('later failure');
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      expect(runKey).toBe('charge-fixed-key');
      expect(undoKey).toBe('charge-fixed-key:undo');
      expect(report(result, 'charge').idempotencyKey).toBe('charge-fixed-key');
    });
  });

  describe('function override', () => {
    it('evaluates the function exactly once for a step that retries three times', async () => {
      const keyFn = vi.fn((ctx: Ctx) => `charge:${ctx.input.orderId}`);
      const keys: string[] = [];
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: (_ctx, meta) => {
              keys.push(meta.idempotencyKey);
              throw new Error('service unavailable');
            },
            retry: { attempts: 3, delayMs: 0 },
            idempotencyKey: keyFn,
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      // Three attempts, one evaluation — re-evaluating per attempt would
      // defeat the purpose of the key.
      expect(keys).toHaveLength(3);
      expect(keyFn).toHaveBeenCalledTimes(1);
      expect(keys).toEqual(['charge:ord_1', 'charge:ord_1', 'charge:ord_1']);
      expect(report(result, 'charge').idempotencyKey).toBe('charge:ord_1');
    });

    it('evaluates the function with the run context', async () => {
      const keyFn = vi.fn((ctx: Ctx) => `charge:${ctx.input.orderId}`);
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: keyFn,
          }),
        )
        .execute(input);

      expect(keyFn).toHaveBeenCalledTimes(1);
      expect(keyFn.mock.calls[0]?.[0]).toBe(result.context);
    });

    it('appends ":undo" to a function-derived key for the compensation', async () => {
      let undoKey: string | undefined;
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: () => {},
            undo: (_ctx, meta) => {
              undoKey = meta.idempotencyKey;
            },
            idempotencyKey: (ctx) => `charge:${ctx.input.orderId}`,
          }),
        )
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('later failure');
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      expect(undoKey).toBe('charge:ord_1:undo');
    });

    it('treats a throwing key function as a step failure, not a UsageError', async () => {
      const raw = new Error('cannot derive key');
      const undoPrior = vi.fn();
      const run = vi.fn();
      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('prior', { run: () => {}, undo: undoPrior }))
        .addStep(
          new Step<Ctx>('charge', {
            run,
            idempotencyKey: () => {
              throw raw;
            },
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      // A runtime failure of user code, wrapped like any other step failure.
      expect(result.error).toBeInstanceOf(StepError);
      expect(result.error).not.toBeInstanceOf(UsageError);
      expect((result.error as StepError).stepName).toBe('charge');
      expect((result.error as StepError).cause).toBe(raw);
      // The run never happened, so there is no attempt and no key to report.
      expect(run).not.toHaveBeenCalled();
      const charge = report(result, 'charge');
      expect(charge.status).toBe('failed');
      expect(charge.idempotencyKey).toBeUndefined();
      expect(charge.attempts).toBeUndefined();
      // Rollback proceeds normally for prior steps.
      expect(undoPrior).toHaveBeenCalledTimes(1);
      expect(report(result, 'prior').status).toBe('rolled-back');
    });

    it('fails a parallel step whose key function throws, cancelling its peers', async () => {
      const raw = new Error('cannot derive key');
      const peerRun = vi.fn();
      const undoPrior = vi.fn();
      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('prior', { run: () => {}, undo: undoPrior }))
        .addParallel([
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: () => {
              throw raw;
            },
          }),
          // Cooperative: only the group abort can end it.
          new Step<Ctx>('peer', (_ctx, meta) => {
            peerRun();
            return new Promise<void>((_resolve, reject) => {
              meta.signal.addEventListener(
                'abort',
                () => reject(meta.signal.reason),
                { once: true },
              );
            });
          }),
        ])
        .execute(input);

      expect(result.ok).toBe(false);
      expect(result.aborted).toBe(false);
      // The key failure is this step's failure and aborts the group.
      const charge = report(result, 'charge');
      expect(charge.status).toBe('failed');
      expect(charge.idempotencyKey).toBeUndefined();
      expect(charge.attempts).toBeUndefined();
      expect((result.error as StepError).stepName).toBe('charge');
      expect((result.error as StepError).cause).toBe(raw);
      // The peer had already started and was cancelled by the group abort.
      expect(peerRun).toHaveBeenCalledTimes(1);
      expect(report(result, 'peer').skipReason).toBe(
        'cancelled (parallel peer failed)',
      );
      expect(undoPrior).toHaveBeenCalledTimes(1);
    });
  });

  describe('construction validation', () => {
    it('accepts a non-empty string and a function', () => {
      expect(
        () =>
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: 'fixed',
          }),
      ).not.toThrow();
      expect(
        () =>
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: (ctx) => ctx.input.orderId,
          }),
      ).not.toThrow();
    });

    it('throws a UsageError for an empty string', () => {
      expect(
        () => new Step<Ctx>('charge', { run: () => {}, idempotencyKey: '' }),
      ).toThrow(UsageError);
    });

    it.each([
      ['a number', 123],
      ['null', null],
      ['an object', {}],
      ['a boolean', true],
    ])('throws a UsageError for %s', (_label, value) => {
      expect(
        () =>
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: value as unknown as string,
          }),
      ).toThrow(UsageError);
    });

    it('preserves the key through .when()', () => {
      const original = new Step<Ctx>('charge', {
        run: () => {},
        idempotencyKey: 'fixed',
      });

      expect(original.when(() => true).idempotencyKey).toBe('fixed');
    });
  });

  describe('reporting', () => {
    it('reports a key for steps that ran and omits it for skipped ones', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('guarded-out', { run: () => {}, when: () => false }),
        )
        .addStep(new Step<Ctx>('ran', { run: () => {}, undo: () => {} }))
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('later failure');
          }),
        )
        .execute(input);

      expect(result.ok).toBe(false);
      // Skipped steps never ran, so they carry no key.
      expect(report(result, 'guarded-out').idempotencyKey).toBeUndefined();
      // A rolled-back step keeps the key its run was invoked with.
      expect(report(result, 'ran').status).toBe('rolled-back');
      expect(report(result, 'ran').idempotencyKey).toBe(
        `${result.executionId}:ran`,
      );
      // The failing step ran too.
      expect(report(result, 'boom').idempotencyKey).toBe(
        `${result.executionId}:boom`,
      );
    });

    it('omits the key for steps cancelled before they ran', async () => {
      const controller = new AbortController();
      controller.abort(new Error('too late'));

      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('a', () => {}))
        .addStep(new Step<Ctx>('b', () => {}))
        .execute(input, { signal: controller.signal });

      expect(result.aborted).toBe(true);
      for (const name of ['a', 'b']) {
        expect(report(result, name).status).toBe('skipped');
        expect(report(result, name).idempotencyKey).toBeUndefined();
      }
    });

    it('omits the key from a dry-run plan', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute(input, { dryRun: true });

      expect(result.steps[0]?.status).toBe('would-run');
      expect(result.steps[0]?.idempotencyKey).toBeUndefined();
    });
  });
});
