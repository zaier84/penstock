import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError } from '../src/errors';
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

/** A run that never settles, so only the timeout can end the attempt. */
const neverResolves = (): Promise<void> => new Promise<void>(() => {});

describe('Pipeline timeout (section 1.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a step that finishes before its timeout (no timedOut)', async () => {
    vi.useFakeTimers();
    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('s', { run: () => {}, timeout: 1000 }))
      .execute({});

    expect(result.ok).toBe(true);
    const r = report(result, 's');
    expect(r.status).toBe('completed');
    expect(r.timedOut).toBeUndefined();
  });

  it('fails a step that exceeds its timeout and rolls back prior steps', async () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    const promise = new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', { run: () => {}, undo }))
      .addStep(new Step<Ctx>('slow', { run: neverResolves, timeout: 20 }))
      .execute({});

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(false);
    const r = report(result, 'slow');
    expect(r.status).toBe('failed');
    expect(r.timedOut).toBe(true);
    // The captured error is the TimeoutError DOMException (section 1.2).
    const cause = (result.error as StepError).cause as Error;
    expect(cause.name).toBe('TimeoutError');
    // Rollback ran: the prior completed step's undo fired.
    expect(undo).toHaveBeenCalledTimes(1);
    expect(report(result, 'a').status).toBe('rolled-back');
  });

  it('heals a timeout on retry: times out on attempt 1, succeeds on attempt 2', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const run = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? neverResolves() : Promise.resolve();
    });
    const promise = new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('s', {
          run,
          timeout: 20,
          retry: { attempts: 3, delayMs: 0 },
        }),
      )
      .execute({});

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(true);
    const r = report(result, 's');
    expect(r.status).toBe('completed');
    expect(r.attempts).toBe(2);
    expect(r.timedOut).toBeUndefined(); // a successful attempt heals it
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails when every attempt times out', async () => {
    vi.useFakeTimers();
    const run = vi.fn(neverResolves);
    const promise = new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('s', {
          run,
          timeout: 20,
          retry: { attempts: 2, delayMs: 0 },
        }),
      )
      .execute({});

    // Advance past both per-attempt budgets (the second timeout is created after
    // the first fires, mid-advance).
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.ok).toBe(false);
    const r = report(result, 's');
    expect(r.status).toBe('failed');
    expect(r.timedOut).toBe(true);
    expect(r.attempts).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('exposes the combined timeout+cancellation signal as ctx.signal', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    let captured: AbortSignal | undefined;
    const promise = new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('s', {
          run: (ctx) => {
            captured = ctx.signal;
            return neverResolves();
          },
          timeout: 20,
        }),
      )
      .execute({}, { signal: outer.signal });

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(captured).toBeInstanceOf(AbortSignal);
    // It is the combined signal, not the raw pipeline signal.
    expect(captured).not.toBe(outer.signal);
    expect(captured?.aborted).toBe(true);
    expect((captured?.reason as Error).name).toBe('TimeoutError');
  });

  it('leaves ctx.signal as the pipeline signal when no timeout is set', async () => {
    const outer = new AbortController();
    let captured: AbortSignal | undefined;
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('s', (ctx) => {
          captured = ctx.signal;
        }),
      )
      .execute({}, { signal: outer.signal });

    expect(result.ok).toBe(true);
    // No combining: ctx.signal is exactly the pipeline signal (existing behaviour).
    expect(captured).toBe(outer.signal);
  });
});
