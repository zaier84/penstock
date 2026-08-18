import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import { defineStep, pipeline } from '../src/typed/index';

interface Input {
  id: string;
}

const INPUT: Input = { id: 'ord_1' };

/** First stage of the two-stage call, reused across this suite. */
const forInput = defineStep<Input>();

describe('defineStep and use (0.5.0 section 2.5)', () => {
  it('runs a defined step and threads its contribution on', async () => {
    const fetchUser = forInput('fetch-user', async () => ({
      user: { id: 'u1' },
    }));

    const seen: unknown[] = [];
    const result = await pipeline<Input>('uses')
      .use(fetchUser)
      .step('after', (ctx) => {
        seen.push(ctx.user);
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.user).toEqual({ id: 'u1' });
    expect(seen).toEqual([{ id: 'u1' }]);
    expect(result.steps.map((s) => s.name)).toEqual(['fetch-user', 'after']);
  });

  it('reuses one definition across two independent pipelines', async () => {
    const shared = forInput('shared', (ctx) => ({ echoed: ctx.input.id }));

    const first = await pipeline<Input>('first').use(shared).execute(INPUT);
    const second = await pipeline<Input>('second')
      .use(shared)
      .execute({ id: 'ord_2' });

    expect(first.context.echoed).toBe('ord_1');
    expect(second.context.echoed).toBe('ord_2');
  });

  it('satisfies a declared prior-state requirement at runtime', async () => {
    const needsToken = defineStep<Input, { token: string }>()(
      'call-api',
      (ctx) => ({ profile: 'profile-for-' + ctx.token }),
    );

    const result = await pipeline<Input>('requires')
      .step('auth', () => ({ token: 'tok_1' }))
      .use(needsToken)
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.profile).toBe('profile-for-tok_1');
  });

  it('carries the definition own modifiers through use()', async () => {
    let calls = 0;
    const flaky = forInput('flaky', () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return { settled: true };
    }).retry({ attempts: 3 });

    const result = await pipeline<Input>('modified').use(flaky).execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.attempts).toBe(3);
    expect(result.context.settled).toBe(true);
  });

  it('accepts a builder modifier after use()', async () => {
    const undone: string[] = [];
    const reserve = forInput('reserve', () => ({ reservationId: 'r1' }));

    const result = await pipeline<Input>('undo-after-use')
      .use(reserve)
      .undo((ctx) => {
        undone.push(ctx.reservationId);
      })
      .step('boom', () => {
        throw new Error('boom');
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(undone).toEqual(['r1']);
    expect(result.steps[0]?.status).toBe('rolled-back');
  });
});

describe('StepDef modifiers return a new definition (0.5.0 section 2.5)', () => {
  it('leaves the original definition untouched', async () => {
    let calls = 0;
    const base = forInput('counted', () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return { done: true };
    });
    const retrying = base.retry({ attempts: 3 });

    expect(retrying).not.toBe(base);
    expect(retrying.name).toBe(base.name);

    // The modified definition retries; the original still runs exactly once.
    const withRetry = await pipeline<Input>('with')
      .use(retrying)
      .execute(INPUT);
    expect(withRetry.ok).toBe(true);
    expect(withRetry.steps[0]?.attempts).toBe(3);

    calls = 0;
    const without = await pipeline<Input>('without').use(base).execute(INPUT);
    expect(without.ok).toBe(false);
    expect(without.steps[0]?.attempts).toBe(1);
  });

  it('guards a definition with when()', async () => {
    const guarded = forInput('guarded', () => ({ value: 1 })).when(() => false);

    const result = await pipeline<Input>('guard').use(guarded).execute(INPUT);

    expect(result.steps[0]?.status).toBe('skipped');
    expect(result.steps[0]?.skipReason).toBe('guard returned false');
    expect('value' in result.context).toBe(false);
  });

  it('compensates a definition with undo()', async () => {
    const undone: string[] = [];
    const reserve = forInput('reserve', () => ({ reservationId: 'r1' })).undo(
      (ctx) => {
        undone.push(ctx.reservationId);
      },
    );

    const result = await pipeline<Input>('def-undo')
      .use(reserve)
      .step('boom', () => {
        throw new Error('boom');
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(undone).toEqual(['r1']);
  });

  it('applies timeout() and idempotencyKey() to a definition', async () => {
    const slow = forInput('slow', () => new Promise<void>(() => {})).timeout(
      20,
    );
    const timedOut = await pipeline<Input>('t').use(slow).execute(INPUT);
    expect(timedOut.steps[0]?.timedOut).toBe(true);

    const keyed = forInput('keyed', () => {}).idempotencyKey(
      (ctx) => 'charge:' + ctx.input.id,
    );
    const result = await pipeline<Input>('k').use(keyed).execute(INPUT);
    expect(result.steps[0]?.idempotencyKey).toBe('charge:ord_1');
  });

  it('replaces rather than combines when a modifier is applied twice', async () => {
    const twice = forInput('twice', () => ({ v: 1 }))
      .idempotencyKey('first')
      .idempotencyKey('second');

    const result = await pipeline<Input>('twice').use(twice).execute(INPUT);
    expect(result.steps[0]?.idempotencyKey).toBe('second');
  });

  it('exposes the constructed Step so the builder can register it', () => {
    const def = forInput('exposed', () => {});
    expect(def.step).toBeInstanceOf(Step);
    expect(def.step.name).toBe('exposed');
  });

  it.each(['', '__proto__', 'prototype', 'constructor'])(
    'rejects the definition name "%s"',
    (name) => {
      expect(() => forInput(name, () => {})).toThrow(UsageError);
    },
  );
});

describe('typed parallel groups (0.5.0 sections 1.2 and 2.4)', () => {
  it('merges the contributions of every step in the group', async () => {
    const result = await pipeline<Input>('fanout')
      .parallel([
        forInput('inventory', async () => {
          await sleep(10);
          return { inventoryToken: 'inv' };
        }),
        forInput('pricing', async () => ({ price: 250 })),
        forInput('fraud', async () => ({ fraudScore: 0.02 })),
      ])
      .step('after', (ctx) => {
        expect(ctx.inventoryToken).toBe('inv');
        expect(ctx.price).toBe(250);
        expect(ctx.fraudScore).toBe(0.02);
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.inventoryToken).toBe('inv');
    expect(result.context.price).toBe(250);
    expect(result.context.fraudScore).toBe(0.02);
  });

  it('reports steps in declaration order, not completion order', async () => {
    const finished: string[] = [];
    const result = await pipeline<Input>('ordering')
      .parallel([
        forInput('slowest', async () => {
          await sleep(60);
          finished.push('slowest');
          return { a: 1 };
        }),
        forInput('middle', async () => {
          await sleep(30);
          finished.push('middle');
          return { b: 2 };
        }),
        forInput('fastest', async () => {
          await sleep(5);
          finished.push('fastest');
          return { c: 3 };
        }),
      ])
      .execute(INPUT);

    // Declaration order is what defines rollback order and first-failure
    // selection, which is why parallel takes an array (spec section 1.2).
    expect(finished).toEqual(['fastest', 'middle', 'slowest']);
    expect(result.steps.map((s) => s.name)).toEqual([
      'slowest',
      'middle',
      'fastest',
    ]);
  });

  it('honours a concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const slot = (name: string) =>
      forInput(name, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(25);
        inFlight -= 1;
      });

    const result = await pipeline<Input>('bounded')
      .parallel([slot('a'), slot('b'), slot('c'), slot('d'), slot('e')], {
        concurrency: 2,
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(peak).toBe(2);
    expect(result.steps).toHaveLength(5);
  });

  it('rolls back completed group steps in reverse declaration order', async () => {
    const undone: string[] = [];
    const ok = (name: string) =>
      forInput(name, () => {}).undo(() => {
        undone.push(name);
      });

    const result = await pipeline<Input>('group-rollback')
      .parallel([
        ok('first'),
        ok('second'),
        forInput('boom', () => {
          throw new Error('group failure');
        }),
      ])
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(undone).toEqual(['second', 'first']);
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('boom');
  });

  it('picks the first failure in declaration order as result.error', async () => {
    const result = await pipeline<Input>('two-failures')
      .parallel([
        forInput('slow-failure', async () => {
          await sleep(40);
          throw new Error('slow');
        }),
        forInput('fast-failure', () => {
          throw new Error('fast');
        }),
      ])
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect((result.error as StepError).stepName).toBe('slow-failure');
  });
});

describe('typed parallel validation (0.5.0 section 3.5)', () => {
  it('delegates group validation to addParallel', () => {
    const one = forInput('only', () => {});
    // Fewer than 2 steps, and a bad concurrency limit, are both refused by
    // Pipeline.addParallel; the builder adds no rules of its own.
    expect(() => pipeline<Input>('p').parallel([one])).toThrow(UsageError);
    expect(() =>
      pipeline<Input>('p').parallel([forInput('a', () => {}), one], {
        concurrency: 0,
      }),
    ).toThrow(UsageError);
    expect(() =>
      pipeline<Input>('p').parallel([forInput('a', () => {}), one], {
        concurrency: 1.5,
      }),
    ).toThrow(UsageError);
  });

  it('rejects a name already used elsewhere in the pipeline', () => {
    expect(() =>
      pipeline<Input>('dup')
        .step('a', () => {})
        .parallel([forInput('a', () => {}), forInput('b', () => {})]),
    ).toThrow(UsageError);

    expect(() =>
      pipeline<Input>('dup2').parallel([
        forInput('same', () => {}),
        forInput('same', () => {}),
      ]),
    ).toThrow(UsageError);
  });

  it.each(['when', 'undo', 'retry', 'timeout', 'idempotencyKey'] as const)(
    'throws a UsageError when .%s() follows a parallel group',
    (modifier) => {
      const builder = pipeline<Input>('group').parallel([
        forInput('a', () => {}),
        forInput('b', () => {}),
      ]) as unknown as Record<string, (arg: unknown) => unknown>;

      // Modifiers target a single step; a group member is modified on its
      // own StepDef instead.
      expect(() => builder[modifier]!(() => true)).toThrow(UsageError);
      expect(() => builder[modifier]!(() => true)).toThrow(/StepDef/);
    },
  );
});

interface InvInput {
  sku: string;
}
interface InvCtx extends BaseContext<InvInput> {
  stock?: number;
}

/** A typed inner pipeline, the usual case. */
const inventory = pipeline<InvInput>('inventory').step('lookup', (ctx) => ({
  stock: 7,
  sku: ctx.input.sku,
}));

describe('typed composition (0.5.0 section 2.4)', () => {
  it('contributes state through a synchronous mapResult', async () => {
    const result = await pipeline<Input>('outer')
      .compose('check-inventory', inventory, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: (inner) => ({ stock: inner.context.stock }),
      })
      .step('after', (ctx) => {
        expect(ctx.stock).toBe(7);
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.stock).toBe(7);
  });

  it('contributes state through an asynchronous mapResult', async () => {
    const result = await pipeline<Input>('outer-async')
      .compose('check-inventory', inventory, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: async (inner) => {
          await sleep(5);
          return { stock: inner.context.stock * 2 };
        },
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.stock).toBe(14);
  });

  it('runs the inner pipeline but contributes nothing without mapResult', async () => {
    const ran: string[] = [];
    const inner = pipeline<InvInput>('side-effect').step('lookup', () => {
      ran.push('inner');
    });

    const result = await pipeline<Input>('no-map')
      .compose('inner', inner, { mapInput: (ctx) => ({ sku: ctx.input.id }) })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(ran).toEqual(['inner']);
    expect(Object.keys(result.context)).toHaveLength(5);
  });

  it('accepts a class-API Pipeline as the inner pipeline', async () => {
    const legacy = new Pipeline<InvCtx>('legacy-inventory').addStep(
      new Step<InvCtx>('lookup', (ctx) => {
        ctx.stock = 3;
      }),
    );

    const result = await pipeline<Input>('mixed')
      .compose('legacy', legacy, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: (inner) => ({ stock: inner.context.stock ?? 0 }),
      })
      .execute(INPUT);

    expect(result.ok).toBe(true);
    expect(result.context.stock).toBe(3);
  });

  it('surfaces the inner Result on the step report', async () => {
    const result = await pipeline<Input>('reported')
      .compose('check-inventory', inventory, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
      })
      .execute(INPUT);

    const report = result.steps[0]!;
    expect(report.innerResult?.ok).toBe(true);
    expect(report.innerResult?.pipelineName).toBe('inventory');
    // A separate execution, so a separate identity (0.4.0 section 1.1).
    expect(report.innerResult?.executionId).not.toBe(result.executionId);
  });
});

describe('typed composition failure and modifiers (0.5.0 section 2.4)', () => {
  it('fails the wrapping step and rolls the outer pipeline back', async () => {
    const undone: string[] = [];
    const failing = pipeline<InvInput>('failing-inner').step('lookup', () => {
      throw new Error('inner exploded');
    });

    const result = await pipeline<Input>('outer-failure')
      .step('reserve', () => ({ reservationId: 'r1' }))
      .undo((ctx) => {
        undone.push(ctx.reservationId);
      })
      .compose('inner', failing, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: () => ({ never: true }),
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    expect(undone).toEqual(['r1']);
    expect(result.steps.map((s) => s.status)).toEqual([
      'rolled-back',
      'failed',
    ]);
    // mapResult never ran, so it contributed nothing.
    expect('never' in result.context).toBe(false);
    expect(result.steps[1]?.innerResult?.ok).toBe(false);
  });

  it('accepts builder modifiers chained after compose', async () => {
    const undone: string[] = [];
    const result = await pipeline<Input>('compose-undo')
      .compose('check-inventory', inventory, {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: (inner) => ({ stock: inner.context.stock }),
      })
      .undo((ctx) => {
        undone.push('released:' + String(ctx.stock));
      })
      .step('boom', () => {
        throw new Error('later failure');
      })
      .execute(INPUT);

    expect(result.ok).toBe(false);
    // The inner pipeline is never re-rolled-back; this undo reverses its net
    // effect (0.3.0 section 1.2.4, scenario B).
    expect(undone).toEqual(['released:7']);
  });

  it('skips a guarded compose without running the inner pipeline', async () => {
    const ran: string[] = [];
    const inner = pipeline<InvInput>('guarded-inner').step('lookup', () => {
      ran.push('inner');
    });

    const result = await pipeline<Input>('guarded-compose')
      .compose('inner', inner, { mapInput: (ctx) => ({ sku: ctx.input.id }) })
      .when(() => false)
      .execute(INPUT);

    expect(result.steps[0]?.status).toBe('skipped');
    expect(ran).toEqual([]);
  });

  it('keeps concurrent compositions independent', async () => {
    const builder = pipeline<Input>('reentrant-compose').compose(
      'check-inventory',
      inventory,
      {
        mapInput: (ctx) => ({ sku: ctx.input.id }),
        mapResult: async (inner) => {
          await sleep(10);
          return { sku: inner.context.sku };
        },
      },
    );

    const [first, second] = await Promise.all([
      builder.execute({ id: 'one' }),
      builder.execute({ id: 'two' }),
    ]);

    // The captured inner Result is keyed by the outer context, so two runs in
    // flight at once never read each other.
    expect(first.context.sku).toBe('one');
    expect(second.context.sku).toBe('two');
  });
});

describe('definition validation (0.5.0 section 3.5)', () => {
  it('rejects a use() argument that is not a step definition', () => {
    // The brand is a type-level fiction with no runtime trace, so the spec
    // registry is the only way to tell a definition from a stray object.
    expect(() =>
      pipeline<Input>('bad-use').use({ name: 'imposter' } as never),
    ).toThrow(UsageError);
    expect(() =>
      pipeline<Input>('bad-use2').use(new Step('real-step', () => {}) as never),
    ).toThrow(/defineStep/);
  });

  it('rejects a parallel() member that is not a step definition', () => {
    expect(() =>
      pipeline<Input>('bad-parallel').parallel([
        forInput('a', () => {}),
        {} as never,
      ]),
    ).toThrow(UsageError);
  });
});
