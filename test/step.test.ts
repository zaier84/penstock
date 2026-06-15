import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { UsageError } from '../src/errors';
import { Step } from '../src/step';
import type { GuardFn, RunFn, StepOptions, UndoFn } from '../src/types';

interface TestCtx extends BaseContext {
  reservationId?: string;
}

const noopRun: RunFn<TestCtx> = () => {};

describe('Step', () => {
  describe('construction', () => {
    it('accepts a bare run function as the second argument', () => {
      const step = new Step<TestCtx>('validate-order', noopRun);
      expect(step.name).toBe('validate-order');
      expect(step.run).toBe(noopRun);
      expect(step.guard).toBeUndefined();
      expect(step.undo).toBeUndefined();
    });

    it('accepts a full options object and stores run, when, and undo', () => {
      const run: RunFn<TestCtx> = () => {};
      const when: GuardFn<TestCtx> = () => true;
      const undo: UndoFn<TestCtx> = () => {};
      const step = new Step<TestCtx>('reserve-inventory', { run, when, undo });
      expect(step.name).toBe('reserve-inventory');
      expect(step.run).toBe(run);
      expect(step.guard).toBe(when);
      expect(step.undo).toBe(undo);
    });

    it('leaves guard and undo undefined when options supply only run', () => {
      const run: RunFn<TestCtx> = () => {};
      const step = new Step<TestCtx>('calculate-total', { run });
      expect(step.run).toBe(run);
      expect(step.guard).toBeUndefined();
      expect(step.undo).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('throws UsageError when the options omit run', () => {
      expect(
        () => new Step<TestCtx>('no-run', {} as StepOptions<TestCtx>),
      ).toThrow(UsageError);
    });

    it('throws UsageError for an empty name', () => {
      expect(() => new Step<TestCtx>('', noopRun)).toThrow(UsageError);
    });

    it('throws UsageError for a non-string name', () => {
      expect(
        () => new Step<TestCtx>(123 as unknown as string, noopRun),
      ).toThrow(UsageError);
    });

    it.each(['__proto__', 'prototype', 'constructor'])(
      'throws UsageError for the reserved name %s',
      (name) => {
        expect(() => new Step<TestCtx>(name, noopRun)).toThrow(UsageError);
      },
    );
  });

  describe('retry and timeout options', () => {
    it.each([0, -1])(
      'throws UsageError when retry.attempts is %i (below 1)',
      (attempts) => {
        expect(
          () => new Step<TestCtx>('x', { run: noopRun, retry: { attempts } }),
        ).toThrow(UsageError);
      },
    );

    it('accepts retry.attempts of 1 (valid, no actual retry)', () => {
      const step = new Step<TestCtx>('x', {
        run: noopRun,
        retry: { attempts: 1 },
      });
      expect(step.retry).toEqual({ attempts: 1 });
    });

    it('throws UsageError for a negative retry.delayMs', () => {
      expect(
        () =>
          new Step<TestCtx>('x', {
            run: noopRun,
            retry: { attempts: 2, delayMs: -1 },
          }),
      ).toThrow(UsageError);
    });

    it('accepts a retry.delayMs of 0', () => {
      const step = new Step<TestCtx>('x', {
        run: noopRun,
        retry: { attempts: 2, delayMs: 0 },
      });
      expect(step.retry).toEqual({ attempts: 2, delayMs: 0 });
    });

    it.each([0, -100])(
      'throws UsageError when timeout is %i (not > 0)',
      (timeout) => {
        expect(() => new Step<TestCtx>('x', { run: noopRun, timeout })).toThrow(
          UsageError,
        );
      },
    );

    it('accepts a positive timeout', () => {
      const step = new Step<TestCtx>('x', { run: noopRun, timeout: 1000 });
      expect(step.timeout).toBe(1000);
    });

    it('accepts retry and timeout together', () => {
      const step = new Step<TestCtx>('x', {
        run: noopRun,
        retry: { attempts: 3 },
        timeout: 2000,
      });
      expect(step.retry).toEqual({ attempts: 3 });
      expect(step.timeout).toBe(2000);
    });

    it('leaves retry and timeout undefined when not supplied', () => {
      const step = new Step<TestCtx>('x', noopRun);
      expect(step.retry).toBeUndefined();
      expect(step.timeout).toBeUndefined();
    });

    it('preserves retry and timeout through .when()', () => {
      const original = new Step<TestCtx>('x', {
        run: noopRun,
        retry: { attempts: 3, delayMs: 50 },
        timeout: 2000,
      });
      const guarded = original.when(() => true);
      expect(guarded.retry).toEqual({ attempts: 3, delayMs: 50 });
      expect(guarded.timeout).toBe(2000);
    });
  });

  describe('.when()', () => {
    it('returns a new Step with the guard set, leaving the original untouched', () => {
      const run: RunFn<TestCtx> = () => {};
      const undo: UndoFn<TestCtx> = () => {};
      const original = new Step<TestCtx>('discount', { run, undo });
      const guard: GuardFn<TestCtx> = () => true;
      const guarded = original.when(guard);

      expect(guarded).not.toBe(original);
      expect(original.guard).toBeUndefined();
      expect(guarded.guard).toBe(guard);
      expect(guarded.name).toBe('discount');
      expect(guarded.run).toBe(run);
      expect(guarded.undo).toBe(undo);
    });

    it('replaces a prior guard rather than combining them', () => {
      const first: GuardFn<TestCtx> = () => true;
      const second: GuardFn<TestCtx> = () => false;
      const original = new Step<TestCtx>('discount', {
        run: noopRun,
        when: first,
      });
      const replaced = original.when(second);

      expect(original.guard).toBe(first);
      expect(replaced.guard).toBe(second);
    });
  });
});
