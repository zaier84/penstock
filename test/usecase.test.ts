import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import { UseCase } from '../src/usecase';

interface FlowInput {
  fail: boolean;
  tag: string;
}

// Two distinct context shapes, both over the same input, to mirror a real
// use-case composed of pipelines that each maintain their own working fields.
interface CtxA extends BaseContext<FlowInput> {
  aRan?: boolean;
}
interface CtxB extends BaseContext<FlowInput> {
  bRan?: boolean;
}

describe('UseCase', () => {
  describe('construction', () => {
    it('rejects an empty or non-string name', () => {
      expect(() => new UseCase('')).toThrow(UsageError);
      expect(() => new UseCase(123 as unknown as string)).toThrow(UsageError);
    });

    it.each(['__proto__', 'prototype', 'constructor'])(
      'rejects the reserved name "%s"',
      (name) => {
        expect(() => new UseCase(name)).toThrow(UsageError);
      },
    );
  });

  describe('addPipeline', () => {
    it('rejects a non-Pipeline argument with a UsageError', () => {
      const useCase = new UseCase<FlowInput>('checkout');
      expect(() =>
        useCase.addPipeline(123 as unknown as Pipeline<CtxA>),
      ).toThrow(UsageError);
    });

    it('is chainable (returns this)', () => {
      const useCase = new UseCase<FlowInput>('checkout');
      const pipeline = new Pipeline<CtxA>('a').addStep(
        new Step<CtxA>('s', () => {}),
      );
      expect(useCase.addPipeline(pipeline)).toBe(useCase);
    });
  });

  describe('execute', () => {
    it('runs pipelines in order, each on the same input', async () => {
      const order: string[] = [];
      const seen: FlowInput[] = [];
      const input: FlowInput = { fail: false, tag: 'x' };

      const a = new Pipeline<CtxA>('a').addStep(
        new Step<CtxA>('a-step', (ctx) => {
          order.push('A');
          seen.push(ctx.input);
        }),
      );
      const b = new Pipeline<CtxB>('b').addStep(
        new Step<CtxB>('b-step', (ctx) => {
          order.push('B');
          seen.push(ctx.input);
        }),
      );

      const result = await new UseCase<FlowInput>('checkout')
        .addPipeline(a)
        .addPipeline(b)
        .execute(input);

      expect(order).toEqual(['A', 'B']);
      expect(result.pipelines).toHaveLength(2);
      // The same input reference is threaded into every pipeline (section 3.6).
      expect(result.pipelines[0]?.context.input).toBe(input);
      expect(result.pipelines[1]?.context.input).toBe(input);
      expect(seen[0]).toBe(input);
      expect(seen[1]).toBe(input);
    });

    it('gives each pipeline its own isolated context', async () => {
      const a = new Pipeline<CtxA>('a').addStep(
        new Step<CtxA>('a-step', (ctx) => {
          ctx.aRan = true;
        }),
      );
      const b = new Pipeline<CtxB>('b').addStep(
        new Step<CtxB>('b-step', (ctx) => {
          ctx.bRan = true;
        }),
      );

      const result = await new UseCase<FlowInput>('checkout')
        .addPipeline(a)
        .addPipeline(b)
        .execute({ fail: false, tag: 'x' });

      // Each pipeline builds a fresh context; they are not shared (section 3.3).
      expect(result.pipelines[0]?.context).not.toBe(
        result.pipelines[1]?.context,
      );
    });

    it('aggregates an ok result when every pipeline succeeds', async () => {
      const a = new Pipeline<CtxA>('a').addStep(
        new Step<CtxA>('a-step', () => {}),
      );
      const b = new Pipeline<CtxB>('b').addStep(
        new Step<CtxB>('b-step', () => {}),
      );

      const result = await new UseCase<FlowInput>('checkout')
        .addPipeline(a)
        .addPipeline(b)
        .execute({ fail: false, tag: 'x' });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.pipelines).toHaveLength(2);
      expect(result.pipelines.every((r) => r.ok)).toBe(true);
    });

    it('short-circuits on the first pipeline returning ok:false', async () => {
      const laterStep = vi.fn();

      const failing = new Pipeline<CtxA>('failing').addStep(
        new Step<CtxA>('boom', () => {
          throw new Error('pipeline failed');
        }),
      );
      const later = new Pipeline<CtxB>('later').addStep(
        new Step<CtxB>('later-step', laterStep),
      );

      const result = await new UseCase<FlowInput>('checkout')
        .addPipeline(failing)
        .addPipeline(later)
        .execute({ fail: true, tag: 'x' });

      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(StepError);
      // The failing pipeline's Result is included; the later one never runs.
      expect(result.pipelines).toHaveLength(1);
      expect(laterStep).not.toHaveBeenCalled();
    });

    it('returns ok with no pipelines for an empty use-case', async () => {
      const result = await new UseCase<FlowInput>('empty').execute({
        fail: false,
        tag: 'x',
      });

      expect(result.ok).toBe(true);
      expect(result.pipelines).toEqual([]);
      expect(result.error).toBeNull();
    });
  });
});
