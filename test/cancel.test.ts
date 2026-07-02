import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { PipelineError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepReport } from '../src/types';

interface Ctx extends BaseContext {
  marker?: string;
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report(result: Result<Ctx>, name: string): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

describe('Pipeline cancellation (section 1.3)', () => {
  it('skips every step as "cancelled" when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    const runA = vi.fn();
    const runB = vi.fn();

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', runA))
      .addStep(new Step<Ctx>('b', runB))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    // The abort reason is surfaced unwrapped, not as a StepError (section 1.3).
    expect(result.error).toBe(reason);
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
    for (const name of ['a', 'b']) {
      const r = report(result, name);
      expect(r.status).toBe('skipped');
      expect(r.skipReason).toBe('cancelled');
    }
  });

  it('rolls back completed steps and skips the rest when aborted between steps', async () => {
    const controller = new AbortController();
    const reason = new Error('stop now');
    const undoA = vi.fn();
    const runB = vi.fn();

    const result = await new Pipeline<Ctx>('p')
      // `a` completes, then aborts the signal from inside its own run; the
      // between-step check before `b` is what stops the pipeline.
      .addStep(
        new Step<Ctx>('a', {
          run: () => {
            controller.abort(reason);
          },
          undo: undoA,
        }),
      )
      .addStep(new Step<Ctx>('b', runB))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(reason);
    // `a` completed, so it rolls back; `b` never ran.
    expect(undoA).toHaveBeenCalledTimes(1);
    expect(report(result, 'a').status).toBe('rolled-back');
    expect(report(result, 'b').status).toBe('skipped');
    expect(report(result, 'b').skipReason).toBe('cancelled');
    expect(runB).not.toHaveBeenCalled();
    expect(result.rollbackErrors).toEqual([]);
  });

  it('runs normally when the passed signal is never aborted', async () => {
    const controller = new AbortController();
    const runA = vi.fn();
    const runB = vi.fn();

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', runA))
      .addStep(new Step<Ctx>('b', runB))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(report(result, 'a').status).toBe('completed');
    expect(report(result, 'b').status).toBe('completed');
  });

  it('surfaces the default AbortError when aborted with no reason', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', () => {}))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    // controller.abort() defaults reason to an AbortError DOMException.
    expect(result.error).toBe(controller.signal.reason);
    expect((result.error as Error).name).toBe('AbortError');
  });

  it('throws a PipelineError whose cause is the abort reason under throwOnError', async () => {
    const controller = new AbortController();
    const reason = new Error('abort cause');
    controller.abort(reason);

    let caught: unknown;
    try {
      await new Pipeline<Ctx>('p')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute({}, { signal: controller.signal, throwOnError: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    expect((caught as PipelineError).cause).toBe(reason);
  });

  it('wakes a retry delay immediately when cancelled, then rolls back', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel during delay');
    const undoA = vi.fn();
    let bCalls = 0;
    const runB = vi.fn(() => {
      bCalls += 1;
      if (bCalls === 1) {
        // Fire the cancel while the (60s) retry delay is awaiting; the delay must
        // wake immediately rather than wait it out (section 1.3).
        setTimeout(() => controller.abort(reason), 0);
      }
      throw new Error('b-fail');
    });

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', { run: () => {}, undo: undoA }))
      .addStep(
        new Step<Ctx>('b', {
          run: runB,
          retry: { attempts: 5, delayMs: 60_000 },
        }),
      )
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(reason);
    // Cancelled during the first delay: `b` ran once and was never retried.
    expect(runB).toHaveBeenCalledTimes(1);
    expect(undoA).toHaveBeenCalledTimes(1);
    expect(report(result, 'a').status).toBe('rolled-back');
    expect(report(result, 'b').status).toBe('skipped');
    expect(report(result, 'b').skipReason).toBe('cancelled');
  });

  it('classifies a mid-run cancel of a timed step as cancellation, not a failure', async () => {
    // A timed step is the tricky case: its `run` is raced against the timeout,
    // and `ctx.signal` also carries the pipeline cancellation. A cooperative run
    // that observes `ctx.signal` and rejects on cancel must still be reported as
    // a *cancellation* (reason surfaced raw, remaining steps skipped, completed
    // steps rolled back) — never as a 'failed' step wrapped in a StepError.
    const controller = new AbortController();
    const reason = new Error('cancel mid-run');
    const undoA = vi.fn();
    const runB = vi.fn(
      (ctx: Ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(ctx.signal.reason),
            {
              once: true,
            },
          );
          // Fire the pipeline cancel while this timed step is running.
          setTimeout(() => controller.abort(reason), 0);
        }),
    );

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', { run: () => {}, undo: undoA }))
      // A large timeout that never fires: only the cancel ends this attempt.
      .addStep(new Step<Ctx>('b', { run: runB, timeout: 60_000 }))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    // Reason surfaces raw, not wrapped in a StepError (section 1.3).
    expect(result.error).toBe(reason);
    expect(report(result, 'b').status).toBe('skipped');
    expect(report(result, 'b').skipReason).toBe('cancelled');
    // The prior completed step rolled back; there are no rollback failures.
    expect(report(result, 'a').status).toBe('rolled-back');
    expect(undoA).toHaveBeenCalledTimes(1);
    expect(result.rollbackErrors).toEqual([]);
  });

  it('does not interrupt a running timed step on cancel; it completes then rolls back', async () => {
    // A *non-cooperative* timed step ignores `ctx.signal`. A pipeline cancel must
    // not abandon it (section 1.3): it runs to completion, so on the between-step
    // check it is rolled back like any completed step — its `undo` runs.
    const controller = new AbortController();
    const reason = new Error('cancel mid-run');
    let bFinished = false;
    const undoB = vi.fn();
    const runB = vi.fn(async () => {
      setTimeout(() => controller.abort(reason), 0);
      await new Promise((r) => setTimeout(r, 10));
      bFinished = true;
    });

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('b', { run: runB, undo: undoB, timeout: 60_000 }))
      .addStep(new Step<Ctx>('c', () => {}))
      .execute({}, { signal: controller.signal });

    // Ran to completion despite the cancel arriving mid-run.
    expect(bFinished).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(reason);
    expect(report(result, 'b').status).toBe('rolled-back');
    expect(undoB).toHaveBeenCalledTimes(1);
    expect(report(result, 'c').status).toBe('skipped');
    expect(report(result, 'c').skipReason).toBe('cancelled');
  });

  it('forwards ctx.signal to a running step, which observes its own abort without being interrupted', async () => {
    const controller = new AbortController();
    let captured: AbortSignal | undefined;
    let abortedBefore: boolean | undefined;
    let abortedAfter: boolean | undefined;

    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('a', (ctx) => {
          captured = ctx.signal;
          abortedBefore = ctx.signal.aborted;
          controller.abort();
          // The currently-running step is not interrupted; it just sees the abort.
          abortedAfter = ctx.signal.aborted;
        }),
      )
      .execute({}, { signal: controller.signal });

    // ctx.signal is the caller's signal (no timeout was set to combine it).
    expect(captured).toBe(controller.signal);
    expect(abortedBefore).toBe(false);
    expect(abortedAfter).toBe(true);
    // The step ran to completion; there was no later step for a between-step
    // check to skip, so the run succeeds.
    expect(result.ok).toBe(true);
    expect(report(result, 'a').status).toBe('completed');
  });
});
