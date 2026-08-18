import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import { pipeline } from '../src/typed/index';

interface Input {
  id: string;
}

const INPUT: Input = { id: 'ord_1' };

/** The wrapped `UsageError` a bad contribution surfaces as (0.5.0 section 3.1). */
function usageCause(error: Error | null): UsageError {
  expect(error).toBeInstanceOf(StepError);
  const cause = (error as StepError).cause;
  expect(cause).toBeInstanceOf(UsageError);
  return cause as UsageError;
}

describe('mergeContribution (0.5.0 section 3.1)', () => {
  it('merges a returned object onto the context', async () => {
    const result = await pipeline<Input>('merge')
      .step('reserve', () => ({ reservationId: 'r1', warehouse: 'LHR' }))
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.reservationId).toBe('r1');
    expect(result.context.warehouse).toBe('LHR');
    // The library's own context fields are untouched by the merge.
    expect(result.context.input).toEqual(INPUT);
    expect(typeof result.context.executionId).toBe('string');
  });

  it('threads each contribution into the next step', async () => {
    const seen: unknown[] = [];
    const result = await pipeline<Input>('thread')
      .step('a', () => ({ a: 1 }))
      .step('b', (ctx) => {
        seen.push(ctx.a);
        return { b: ctx.a + 1 };
      })
      .step('c', (ctx) => {
        seen.push([ctx.a, ctx.b]);
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([1, [1, 2]]);
    expect(result.context.b).toBe(2);
  });

  it('lets a later step overwrite an earlier key', async () => {
    const result = await pipeline<Input>('overwrite')
      .step('a', () => ({ v: 'string-value' }))
      .step('b', () => ({ v: 123 }))
      .execute(INPUT);

    expect(result.context.v).toBe(123);
  });

  it('merges nothing for a void return', async () => {
    const result = await pipeline<Input>('void')
      .step('a', () => {})
      .execute(INPUT);

    expect(result.ok).toBe(true);
    // Only penstock's own five fields; the step added nothing.
    expect(Object.keys(result.context).sort()).toEqual([
      'engines',
      'executionId',
      'input',
      'logger',
      'signal',
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('merges nothing for an explicit %s return', async (_label, value) => {
    const result = await pipeline<Input>('empty')
      .step('a', () => value as unknown as object)
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(Object.keys(result.context)).toHaveLength(5);
  });

  it('accepts a null-prototype object as a plain contribution', async () => {
    const result = await pipeline<Input>('null-proto')
      .step('a', () => {
        const out = Object.create(null) as { token: string };
        out.token = 'tok';
        return out;
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.token).toBe('tok');
  });
});

describe('mergeContribution rejects a non-object return (0.5.0 section 3.1)', () => {
  class Thing {
    value = 1;
  }

  it.each([
    ['an array', [1, 2]],
    ['a function', () => {}],
    ['a Date', new Date()],
    ['a Map', new Map()],
    ['a class instance', new Thing()],
    ['a number', 42],
    ['a string', 'nope'],
    ['a boolean', true],
  ])('fails the step when a run returns %s', async (_label, value: unknown) => {
    const result = await pipeline<Input>('bad')
      .step('offender', () => value as object)
      .execute(INPUT);

    expect(result.ok).toBe(false);
    const cause = usageCause(result.error);
    // Names the step, so an untyped JavaScript caller can find it.
    expect(cause.message).toContain('offender');
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('surfaces the failure as an ordinary step failure that rolls back', async () => {
    const released: string[] = [];
    const result = await pipeline<Input>('rollback-on-bad-return')
      .step('reserve', () => ({ reservationId: 'r1' }))
      .undo((ctx) => {
        released.push(ctx.reservationId);
      })
      .step('offender', () => [1, 2] as unknown as object)
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(false);
    usageCause(result.error);
    expect(result.steps.map((s) => s.status)).toEqual([
      'rolled-back',
      'failed',
    ]);
    expect(released).toEqual(['r1']);
  });
});

describe('mergeContribution guards reserved keys (0.5.0 section 3.1)', () => {
  const RESERVED = ['__proto__', 'prototype', 'constructor'];

  it.each(RESERVED)('rejects a contribution keyed "%s"', async (key) => {
    const result = await pipeline<Input>('reserved')
      .step('hostile', () => {
        // defineProperty makes a genuine own property; the plain literal
        // form would merely set the prototype and create no key at all.
        const out: Record<string, unknown> = {};
        Object.defineProperty(out, key, {
          value: { polluted: true },
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return out;
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    const cause = usageCause(result.error);
    expect(cause.message).toContain(key);
    expect(cause.message).toContain('hostile');
  });

  it('does not pollute Object.prototype through a hostile contribution', async () => {
    const result = await pipeline<Input>('pollute')
      .step('hostile', () => ({ ['__proto__']: { polluted: true } }))
      .execute(INPUT);

    expect(result.ok).toBe(false);
    usageCause(result.error);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
    expect(Object.getPrototypeOf(result.context)).toBe(Object.prototype);
  });

  it('rejects the whole contribution rather than merging it in part', async () => {
    const result = await pipeline<Input>('atomic')
      .step('hostile', () => {
        const out: Record<string, unknown> = { safe: 'kept?' };
        Object.defineProperty(out, 'constructor', {
          value: 'hostile',
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return out;
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    // Validation runs before any write, so the innocent key never lands.
    expect('safe' in result.context).toBe(false);
  });
});

describe('mergeContribution guards reserved context keys (0.5.0 section 3.1)', () => {
  const CONTEXT_KEYS = ['input', 'engines', 'logger', 'signal', 'executionId'];

  it.each(CONTEXT_KEYS)('rejects a contribution keyed "%s"', async (key) => {
    const result = await pipeline<Input>('ctx-key')
      .step('offender', () => ({ [key]: 'hijacked' }))
      .execute(INPUT);

    expect(result.ok).toBe(false);
    const cause = usageCause(result.error);
    expect(cause.message).toContain(key);
    // The field itself is untouched: input is still the original payload.
    expect(result.context.input).toEqual(INPUT);
    expect(typeof result.context.executionId).toBe('string');
    expect(result.context.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('merge on success only (0.5.0 section 3.2)', () => {
  it('merges nothing when the run throws', async () => {
    const result = await pipeline<Input>('throws')
      .step('a', () => ({ a: 1 }))
      .step('b', () => {
        throw new Error('boom');
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(result.context.a).toBe(1);
    // The five library fields plus `a`, and nothing from the failed step.
    expect(Object.keys(result.context)).toHaveLength(6);
  });

  it('merges once, from the attempt that finally succeeded', async () => {
    let attempts = 0;
    const result = await pipeline<Input>('retry')
      .step('flaky', () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky');
        return { attemptsSeen: attempts };
      })
      .retry({ attempts: 3 })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.attempts).toBe(3);
    // Attempts 1 and 2 threw, so they contributed nothing; only the third did.
    expect(result.context.attemptsSeen).toBe(3);
  });
});

describe('no late writes after abort (0.5.0 section 3.3)', () => {
  it('does not merge a timed-out run that resolves after the executor moved on', async () => {
    const finished: string[] = [];
    const result = await pipeline<Input>('late-timeout')
      .step('slow', async () => {
        await sleep(60);
        finished.push('slow');
        return { late: 'value' };
      })
      .timeout(20)
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.timedOut).toBe(true);

    // The abandoned run keeps going and does resolve — the executor simply
    // stopped waiting for it. Its contribution must still not land.
    await sleep(140);
    expect(finished).toEqual(['slow']);
    expect('late' in result.context).toBe(false);
  });

  it('is a genuine improvement over direct context mutation', async () => {
    // The same shape written against the class API: nothing stops the
    // abandoned run from writing, which is the gap the wrapper closes.
    const raw = new Pipeline('late-timeout-raw').addStep(
      new Step('slow', {
        run: async (ctx) => {
          await sleep(60);
          (ctx as { late?: string }).late = 'value';
        },
        timeout: 20,
      }),
    );
    const result = await raw.execute(INPUT);

    expect(result.ok).toBe(false);
    await sleep(140);
    expect('late' in result.context).toBe(true);
  });

  it('does not merge a run that resolves after the pipeline was cancelled', async () => {
    const controller = new AbortController();
    const result = await pipeline<Input>('late-cancel')
      .step('a', async (_ctx, meta) => {
        // Models an external cancel arriving while this run is in flight.
        controller.abort(new Error('cancelled by caller'));
        await sleep(5);
        expect(meta.signal.aborted).toBe(true);
        return { late: 'value' };
      })
      .step('b', () => ({ never: true }))
      .execute(INPUT, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect('late' in result.context).toBe(false);
    expect('never' in result.context).toBe(false);
    expect(result.steps[1]?.skipReason).toBe('cancelled');
  });
});
