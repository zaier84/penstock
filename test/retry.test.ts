import * as timers from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepReport } from '../src/types';

// The retry loop waits via `setTimeout` from node:timers/promises. Mock it to a
// spy that resolves immediately: this records the exact delay each attempt waits
// (deterministic, no real time) and lets us prove a 0ms delay schedules no timer
// at all (section 1.1). It also sidesteps the unreliable interaction between fake
// timers and promise-based timers created mid-drain.
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
}));

interface Ctx extends BaseContext {
  marker?: string;
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report(result: Result<Ctx>, name: string): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

describe('Pipeline retry (section 1.1)', () => {
  describe('basic retry', () => {
    it('retries run and succeeds on the third attempt (no rollback)', async () => {
      let calls = 0;
      const run = vi.fn(() => {
        calls += 1;
        if (calls < 3) throw new Error(`attempt-${calls}`);
      });
      const undo = vi.fn();

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('flaky', { run, undo, retry: { attempts: 3 } }))
        .execute({});

      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledTimes(3);
      expect(undo).not.toHaveBeenCalled();
      const r = report(result, 'flaky');
      expect(r.status).toBe('completed');
      expect(r.attempts).toBe(3);
    });

    it('fails after exhausting all attempts and reports the last error', async () => {
      let calls = 0;
      const run = vi.fn(() => {
        calls += 1;
        throw new Error(`attempt-${calls}`);
      });

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('always-fails', { run, retry: { attempts: 3 } }))
        .execute({});

      expect(result.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(3);
      const r = report(result, 'always-fails');
      expect(r.status).toBe('failed');
      expect(r.attempts).toBe(3);
      // The captured error is the final attempt's, not an aggregate (section 1.1).
      expect(result.error).toBeInstanceOf(StepError);
      expect(((result.error as StepError).cause as Error).message).toBe(
        'attempt-3',
      );
    });

    it('treats attempts:1 as a single try (no retry), reporting attempts:1', async () => {
      const run = vi.fn(() => {
        throw new Error('boom');
      });

      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('once', { run, retry: { attempts: 1 } }))
        .execute({});

      expect(result.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      const r = report(result, 'once');
      expect(r.status).toBe('failed');
      expect(r.attempts).toBe(1);
    });

    it('reports attempts:1 for a step with no retry configured', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('plain', () => {}))
        .execute({});

      expect(result.ok).toBe(true);
      expect(report(result, 'plain').attempts).toBe(1);
    });
  });

  describe('delay and backoff', () => {
    const sleepSpy = vi.mocked(timers.setTimeout);

    beforeEach(() => {
      sleepSpy.mockClear();
    });

    /** A run that always throws, so the pipeline exhausts every attempt. */
    const alwaysFails = () =>
      vi.fn(() => {
        throw new Error('fail');
      });

    it('waits a fixed delay equal to delayMs between every attempt', async () => {
      const run = alwaysFails();
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s', {
            run,
            retry: { attempts: 3, delayMs: 100, backoff: 'fixed' },
          }),
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(3);
      // Two inter-attempt gaps, each exactly delayMs.
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy.mock.calls[0]?.[0]).toBe(100);
      expect(sleepSpy.mock.calls[1]?.[0]).toBe(100);
      expect(report(result, 's').attempts).toBe(3);
    });

    it('doubles the delay each attempt under exponential backoff', async () => {
      const run = alwaysFails();
      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s', {
            run,
            retry: { attempts: 3, delayMs: 100, backoff: 'exponential' },
          }),
        )
        .execute({});

      // attempts 1->2 = delayMs, 2->3 = delayMs * 2 (section 1.1).
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy.mock.calls[0]?.[0]).toBe(100);
      expect(sleepSpy.mock.calls[1]?.[0]).toBe(200);
    });

    it('adds jitter so the delay exceeds the base delay', async () => {
      // Math.random() -> 0.5 makes the jittered delay deterministic: 100 + 0.5*100.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const run = alwaysFails();
      await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s', {
            run,
            retry: { attempts: 2, delayMs: 100, jitter: true },
          }),
        )
        .execute({});

      expect(sleepSpy).toHaveBeenCalledTimes(1);
      const delay = sleepSpy.mock.calls[0]?.[0];
      expect(delay).toBe(150);
      expect(delay).not.toBe(100); // jitter pushed the delay past the base
      randomSpy.mockRestore();
    });

    it('schedules no timer when delayMs is 0', async () => {
      let calls = 0;
      const run = vi.fn(() => {
        calls += 1;
        if (calls < 2) throw new Error('flaky');
      });

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('s', { run, retry: { attempts: 2, delayMs: 0 } }),
        )
        .execute({});

      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledTimes(2);
      expect(sleepSpy).not.toHaveBeenCalled(); // 0ms delay -> no wait scheduled
      expect(report(result, 's').attempts).toBe(2);
    });
  });

  describe('interaction with rollback', () => {
    it('rolls back a prior step when a later step exhausts its retries', async () => {
      const undoA = vi.fn();
      const result = await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', { run: () => {}, undo: undoA }))
        .addStep(
          new Step<Ctx>('b', {
            run: () => {
              throw new Error('b-fail');
            },
            retry: { attempts: 2 },
          }),
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(undoA).toHaveBeenCalledTimes(1);
      expect(report(result, 'a').status).toBe('rolled-back');
      expect(report(result, 'b').attempts).toBe(2);
    });
  });

  describe('guards and undos are not retried', () => {
    it('does not retry a throwing guard; the pipeline fails immediately', async () => {
      const guard = vi.fn(() => {
        throw new Error('guard-boom');
      });
      const run = vi.fn();

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('guarded', {
            run,
            when: guard,
            retry: { attempts: 3 },
          }),
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(guard).toHaveBeenCalledTimes(1); // evaluated once, never retried
      expect(run).not.toHaveBeenCalled();
      expect(report(result, 'guarded').status).toBe('failed');
    });

    it('does not retry a throwing undo; the step is rollback-failed', async () => {
      const undo = vi.fn(() => {
        throw new Error('undo-boom');
      });
      const result = await new Pipeline<Ctx>('p')
        // `a` succeeds (its run is retryable) but its undo throws during rollback.
        .addStep(
          new Step<Ctx>('a', { run: () => {}, undo, retry: { attempts: 3 } }),
        )
        .addStep(
          new Step<Ctx>('b', () => {
            throw new Error('b-fail');
          }),
        )
        .execute({});

      expect(result.ok).toBe(false);
      expect(undo).toHaveBeenCalledTimes(1); // undo is run once, never retried
      expect(report(result, 'a').status).toBe('rollback-failed');
      expect(result.rollbackErrors).toHaveLength(1);
    });
  });
});
