import { describe, expect, it } from 'vitest';

import { Engine } from '../src/engine';
import { PipelineError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import type { Logger } from '../src/logger';
import { pipeline } from '../src/typed/index';

interface Input {
  id: string;
}

const INPUT: Input = { id: 'ord_1' };

describe('the typed builder is a facade over Pipeline (0.5.0 section 3.6)', () => {
  it('builds a real Pipeline carrying every step', () => {
    const built = pipeline<Input>('checkout')
      .step('a', () => ({ a: 1 }))
      .step('b', () => ({ b: 2 }))
      .toPipeline();

    expect(built).toBeInstanceOf(Pipeline);
    expect(built.name).toBe('checkout');
  });

  it('runs identically through toPipeline() and through execute()', async () => {
    const builder = pipeline<Input>('twin').step('a', () => ({ a: 1 }));

    const viaBuilder = await builder.execute(INPUT);
    const viaPipeline = await builder.toPipeline().execute(INPUT);

    expect(viaBuilder.ok).toBe(true);
    expect(viaPipeline.ok).toBe(true);
    // The merge wrapper lives in the Step, so the escape hatch behaves the same.
    expect(viaPipeline.context.a).toBe(1);
    expect(viaBuilder.steps.map((s) => s.name)).toEqual(['a']);
  });

  it('reflects steps added after an earlier toPipeline() call', () => {
    const builder = pipeline<Input>('growing').step('a', () => {});
    const first = builder.toPipeline();
    const second = builder.step('b', () => {}).toPipeline();

    expect(first).not.toBe(second);
    expect(second.name).toBe('growing');
  });

  it('passes execute options straight through', async () => {
    const builder = pipeline<Input>('opts').step('a', () => ({ a: 1 }));

    const planned = await builder.execute(INPUT, { dryRun: true });
    expect(planned.steps.map((s) => s.status)).toEqual(['would-run']);
    // Dry-run plans; it never runs a step, so nothing is merged.
    expect('a' in planned.context).toBe(false);

    const levels: string[] = [];
    const logger: Logger = {
      debug: (msg) => void levels.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    await builder.execute(INPUT, { logger });
    expect(levels).toContain('step completed');
  });

  it('honours throwOnError', async () => {
    const builder = pipeline<Input>('throwing').step('a', () => {
      throw new Error('boom');
    });

    await expect(
      builder.execute(INPUT, { throwOnError: true }),
    ).rejects.toBeInstanceOf(PipelineError);
  });
});

describe('modifiers apply to the most recent step (0.5.0 section 2.3)', () => {
  it('attaches undo, and rolls back in reverse order', async () => {
    const undone: string[] = [];
    const result = await pipeline<Input>('rollback')
      .step('reserve', () => ({ reservationId: 'r1' }))
      .undo((ctx) => {
        undone.push('reserve:' + ctx.reservationId);
      })
      .step('charge', () => ({ chargeId: 'c1' }))
      .undo((ctx) => {
        undone.push('charge:' + ctx.chargeId);
      })
      .step('ship', () => {
        throw new Error('carrier rejected');
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(undone).toEqual(['charge:c1', 'reserve:r1']);
    expect(result.steps.map((s) => s.status)).toEqual([
      'rolled-back',
      'rolled-back',
      'failed',
    ]);
  });

  it('attaches when, guarding only its own step', async () => {
    const result = await pipeline<Input>('guarded')
      .step('a', () => ({ a: 1 }))
      .step('b', () => ({ b: 2 }))
      .when(() => false)
      .step('c', () => ({ c: 3 }))
      .execute(INPUT);

    expect(result.steps.map((s) => s.status)).toEqual([
      'completed',
      'skipped',
      'completed',
    ]);
    expect(result.steps[1]?.skipReason).toBe('guard returned false');
    expect('b' in result.context).toBe(false);
    expect(result.context.c).toBe(3);
  });

  it('attaches retry', async () => {
    let calls = 0;
    const result = await pipeline<Input>('retrying')
      .step('flaky', () => {
        calls += 1;
        if (calls < 2) throw new Error('flaky');
      })
      .retry({ attempts: 3 })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.attempts).toBe(2);
  });

  it('attaches timeout', async () => {
    const result = await pipeline<Input>('timing-out')
      .step('slow', () => new Promise<void>(() => {}))
      .timeout(20)
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.timedOut).toBe(true);
  });

  it('attaches idempotencyKey, string and function alike', async () => {
    const fixed = await pipeline<Input>('keyed')
      .step('a', () => {})
      .idempotencyKey('fixed-key')
      .execute(INPUT);
    expect(fixed.steps[0]?.idempotencyKey).toBe('fixed-key');

    const derived = await pipeline<Input>('derived')
      .step('a', () => {})
      .idempotencyKey((ctx) => 'charge:' + ctx.input.id)
      .execute(INPUT);
    expect(derived.steps[0]?.idempotencyKey).toBe('charge:ord_1');
  });

  it('replaces a modifier applied twice to one step', async () => {
    let calls = 0;
    const result = await pipeline<Input>('replaced')
      .step('a', () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
      })
      .retry({ attempts: 2 })
      .retry({ attempts: 3 })
      .idempotencyKey('first')
      .idempotencyKey('second')
      .execute(INPUT);

    // The second value wins, mirroring Step.prototype.when.
    expect(result.ok).toBe(true);
    expect(result.steps[0]?.attempts).toBe(3);
    expect(result.steps[0]?.idempotencyKey).toBe('second');
  });

  it('replaces a guard applied twice, rather than combining them', async () => {
    const result = await pipeline<Input>('reguarded')
      .step('a', () => ({ a: 1 }))
      .when(() => false)
      .when(() => true)
      .execute(INPUT);

    expect(result.steps[0]?.status).toBe('completed');
  });
});

describe('builder validation (0.5.0 section 3.5)', () => {
  it.each(['when', 'undo', 'retry', 'timeout', 'idempotencyKey'] as const)(
    'throws a UsageError when .%s() precedes any step',
    (modifier) => {
      const empty = pipeline<Input>('bare') as unknown as Record<
        string,
        (arg: unknown) => unknown
      >;
      expect(() => empty[modifier]!(() => true)).toThrow(UsageError);
    },
  );

  it('names the pipeline and the modifier when one precedes any step', () => {
    expect(() => pipeline<Input>('bare').undo(() => {})).toThrow(/bare/);
    expect(() => pipeline<Input>('bare').undo(() => {})).toThrow(/undo/);
  });

  it('throws a UsageError on a duplicate step name, synchronously', () => {
    expect(() =>
      pipeline<Input>('dup')
        .step('a', () => {})
        .step('a', () => {}),
    ).toThrow(UsageError);
  });

  it.each(['', '__proto__', 'prototype', 'constructor'])(
    'throws a UsageError for the step name "%s"',
    (name) => {
      expect(() => pipeline<Input>('names').step(name, () => {})).toThrow(
        UsageError,
      );
    },
  );

  it.each(['', '__proto__', 'prototype', 'constructor'])(
    'throws a UsageError for the pipeline name "%s"',
    (name) => {
      expect(() => pipeline<Input>(name)).toThrow(UsageError);
    },
  );

  it('rejects a duplicate name before the pipeline is ever built', () => {
    const builder = pipeline<Input>('early').step('a', () => {});
    // Nothing has been built yet, so the check cannot be the Pipeline's own —
    // the builder keeps its own registry to fail at the offending call.
    expect(() => builder.step('a', () => {})).toThrow(UsageError);
    // The rejected step left no trace behind.
    expect(builder.toPipeline()).toBeInstanceOf(Pipeline);
  });

  it('still validates through Pipeline when the pipeline is built', async () => {
    const result = await pipeline<Input>('built')
      .step('a', () => {})
      .step('b', () => {})
      .execute(INPUT);
    expect(result.steps.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('observers, lifecycle and engines pass through (0.5.0 section 2.4)', () => {
  it('registers before / after / onError hooks on the built pipeline', async () => {
    const events: string[] = [];
    const result = await pipeline<Input>('hooks')
      .step('a', () => ({ a: 1 }))
      .step('b', () => {
        throw new Error('boom');
      })
      .before((_ctx, step) => void events.push('before:' + step.name))
      .after((_ctx, step) => void events.push('after:' + step.name))
      .onError((_error, _ctx, step) => void events.push('error:' + step.name))
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(events).toEqual(['before:a', 'after:a', 'before:b', 'error:b']);
  });

  it('registers all four lifecycle callbacks', async () => {
    const events: string[] = [];
    const builder = pipeline<Input>('lifecycle')
      .step('a', () => ({ a: 1 }))
      .onComplete((r) => void events.push('complete:' + String(r.ok)))
      .onFailure(() => void events.push('failure'))
      .onCancel(() => void events.push('cancel'))
      .onSettled(() => void events.push('settled'));

    await builder.execute(INPUT);
    expect(events).toEqual(['complete:true', 'settled']);
  });

  it('fires onCancel rather than onFailure for a cancelled run', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await pipeline<Input>('cancelled')
      .step('a', () => {})
      .onFailure(() => void events.push('failure'))
      .onCancel(() => void events.push('cancel'))
      .onSettled(() => void events.push('settled'))
      .execute(INPUT, { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(events).toEqual(['cancel', 'settled']);
  });

  it('registers a pipeline-scoped engine reachable from a step', async () => {
    const pricing = new Engine('pricing', {
      total: (qty: number) => qty * 10,
    });

    const result = await pipeline<Input>('engines')
      .step('price', (ctx) => ({
        total: (ctx.engines.pricing as { total: (q: number) => number }).total(
          3,
        ),
      }))
      .useEngine(pricing)
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.total).toBe(30);
  });
});

describe('re-entrancy (BUILD_SPEC section 3.2)', () => {
  it('keeps concurrent executions of one builder independent', async () => {
    const builder = pipeline<Input>('reentrant').step('a', (ctx) => ({
      seen: ctx.input.id,
    }));

    const [first, second] = await Promise.all([
      builder.execute({ id: 'one' }),
      builder.execute({ id: 'two' }),
    ]);

    expect(first.context.seen).toBe('one');
    expect(second.context.seen).toBe('two');
    expect(first.executionId).not.toBe(second.executionId);
    expect(first.context).not.toBe(second.context);
  });

  it('keeps repeated executions independent', async () => {
    const builder = pipeline<Input>('repeat').step('a', () => ({ n: 1 }));

    const first = await builder.execute(INPUT);
    const second = await builder.execute(INPUT);

    expect(first.context).not.toBe(second.context);
    expect(first.steps).not.toBe(second.steps);
  });
});
