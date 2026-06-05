import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';

interface FlowInput {
  proceed: boolean;
}

type FlowCtx = BaseContext<FlowInput>;

describe('dry-run planning (§1.2)', () => {
  it('plans the flow without calling any run or undo', async () => {
    const run = vi.fn();
    const undo = vi.fn();
    const guard = vi.fn(() => true);

    const result = await new Pipeline<FlowCtx>('plan')
      .addStep(new Step<FlowCtx>('a', { run, undo }))
      .addStep(new Step<FlowCtx>('b', { run, undo, when: guard }))
      .execute({ proceed: true }, { dryRun: true });

    expect(run).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    // Guards are still evaluated during planning.
    expect(guard).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.rollbackErrors).toEqual([]);
    expect(result.steps.map((s) => s.status)).toEqual([
      'would-run',
      'would-run',
    ]);
    expect(result.steps.every((s) => s.durationMs === 0)).toBe(true);
  });

  it('marks guarded-out steps skipped with a skipReason', async () => {
    const result = await new Pipeline<FlowCtx>('plan-skip')
      .addStep(new Step<FlowCtx>('always', () => {}))
      .addStep(
        new Step<FlowCtx>('maybe', {
          run: () => {},
          when: (ctx) => ctx.input.proceed,
        }),
      )
      .execute({ proceed: false }, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.status).toBe('would-run');
    expect(result.steps[1]?.status).toBe('skipped');
    expect(result.steps[1]?.skipReason).toBe('guard returned false');
  });

  it('treats a throwing guard as a failed step, sets ok false, and stops planning', async () => {
    const later = vi.fn();

    const result = await new Pipeline<FlowCtx>('plan-throw')
      .addStep(new Step<FlowCtx>('ok', () => {}))
      .addStep(
        new Step<FlowCtx>('bad', {
          run: () => {},
          when: () => {
            throw new Error('guard boom');
          },
        }),
      )
      .addStep(new Step<FlowCtx>('later', later))
      .execute({ proceed: true }, { dryRun: true });

    expect(result.ok).toBe(false);
    expect(later).not.toHaveBeenCalled();
    // Planning stopped after the throwing guard; 'later' gets no report.
    expect(result.steps.map((s) => s.name)).toEqual(['ok', 'bad']);
    expect(result.steps.find((s) => s.name === 'ok')?.status).toBe('would-run');
    expect(result.steps.find((s) => s.name === 'bad')?.status).toBe('failed');
    expect(result.error).toBeInstanceOf(StepError);
    expect(result.rollbackErrors).toEqual([]);
  });
});
