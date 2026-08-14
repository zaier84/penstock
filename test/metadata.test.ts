import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../src/context';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepMeta, StepReport } from '../src/types';

interface Ctx extends BaseContext {
  marker?: string;
}

interface InnerInput {
  n: number;
}

type InnerCtx = BaseContext<InnerInput>;

/** Looks up a step report by name (names are unique within a pipeline). */
function report<C extends BaseContext>(
  result: Result<C>,
  name: string,
): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

/** Resolves after `ms` of real time. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A run that never settles on its own, so only a timeout can end the attempt. */
const neverSettles = (): Promise<void> => new Promise<void>(() => {});

/**
 * The cooperative pattern the README recommends: settle only when the given
 * signal aborts, rejecting with its reason.
 */
const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

describe('execution identity (section 1.1)', () => {
  it('exposes a non-empty executionId on the context of every step', async () => {
    const seen: string[] = [];
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('a', (ctx) => {
          seen.push(ctx.executionId);
        }),
      )
      .addStep(
        new Step<Ctx>('b', (ctx) => {
          seen.push(ctx.executionId);
        }),
      )
      .execute({});

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(typeof seen[0]).toBe('string');
    expect(seen[0]?.length).toBeGreaterThan(0);
    // One id per execute() call, shared by every step of that run.
    expect(seen[1]).toBe(seen[0]);
  });

  it('surfaces the same id on the Result as on the context', async () => {
    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', () => {}))
      .execute({});

    expect(result.executionId).toBe(result.context.executionId);
    expect(result.executionId.length).toBeGreaterThan(0);
  });

  it('issues a different id for each execute() call on the same pipeline', async () => {
    const pipeline = new Pipeline<Ctx>('p').addStep(
      new Step<Ctx>('a', () => {}),
    );

    const first = await pipeline.execute({});
    const second = await pipeline.execute({});

    expect(first.executionId).not.toBe(second.executionId);
  });

  it('issues distinct ids for concurrent executions (re-entrancy)', async () => {
    const pipeline = new Pipeline<Ctx>('p').addStep(
      new Step<Ctx>('a', async () => {
        await Promise.resolve();
      }),
    );

    const [first, second] = await Promise.all([
      pipeline.execute({}),
      pipeline.execute({}),
    ]);

    expect(first.executionId).not.toBe(second.executionId);
    expect(first.context.executionId).toBe(first.executionId);
    expect(second.context.executionId).toBe(second.executionId);
  });

  it('gives an asStep inner pipeline its own executionId', async () => {
    let innerId: string | undefined;
    const inner = new Pipeline<InnerCtx>('inner').addStep(
      new Step<InnerCtx>('i1', (ctx) => {
        innerId = ctx.executionId;
      }),
    );
    const outer = new Pipeline<Ctx>('outer').addStep(
      inner.asStep<Ctx>('run-inner', { mapInput: () => ({ n: 1 }) }),
    );

    const result = await outer.execute({});

    expect(result.ok).toBe(true);
    // A nested pipeline is a separate execute(), so it gets its own id; the
    // two are correlated through innerResult, never by sharing an id.
    expect(innerId).toBeDefined();
    expect(innerId).not.toBe(result.executionId);
    expect(report(result, 'run-inner').innerResult?.executionId).toBe(innerId);
  });

  it('issues an executionId for a dry-run', async () => {
    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', () => {}))
      .execute({}, { dryRun: true });

    expect(result.steps.map((s) => s.status)).toEqual(['would-run']);
    expect(typeof result.executionId).toBe('string');
    expect(result.executionId.length).toBeGreaterThan(0);
    expect(result.executionId).toBe(result.context.executionId);
  });
});

describe('StepMeta (section 1.2)', () => {
  it('passes run a second argument carrying exactly the seven documented fields', async () => {
    let meta: StepMeta | undefined;
    const result = await new Pipeline<Ctx>('meta-pipeline')
      .addStep(
        new Step<Ctx>('capture', (_ctx, m) => {
          meta = m;
        }),
      )
      .execute({});

    expect(Object.keys(meta ?? {}).sort()).toEqual([
      'attempt',
      'executionId',
      'idempotencyKey',
      'maxAttempts',
      'pipelineName',
      'signal',
      'stepName',
    ]);
    expect(meta?.stepName).toBe('capture');
    expect(meta?.pipelineName).toBe('meta-pipeline');
    expect(meta?.executionId).toBe(result.executionId);
    expect(meta?.attempt).toBe(1);
    expect(meta?.maxAttempts).toBe(1);
    expect(typeof meta?.idempotencyKey).toBe('string');
    expect(meta?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes undo a meta with attempt 1 and maxAttempts 1, even for a retried step', async () => {
    let undoMeta: StepMeta | undefined;
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('a', {
          run: () => {},
          undo: (_ctx, m) => {
            undoMeta = m;
          },
          // Compensations are never retried, whatever the step's run policy.
          retry: { attempts: 3, delayMs: 0 },
        }),
      )
      .addStep(
        new Step<Ctx>('boom', () => {
          throw new Error('later failure');
        }),
      )
      .execute({});

    expect(result.ok).toBe(false);
    expect(undoMeta?.stepName).toBe('a');
    expect(undoMeta?.pipelineName).toBe('p');
    expect(undoMeta?.executionId).toBe(result.executionId);
    expect(undoMeta?.attempt).toBe(1);
    expect(undoMeta?.maxAttempts).toBe(1);
  });

  it('increments meta.attempt across retries and reports the configured maxAttempts', async () => {
    const attempts: number[] = [];
    const maxAttempts: number[] = [];
    let calls = 0;
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('flaky', {
          run: (_ctx, meta) => {
            attempts.push(meta.attempt);
            maxAttempts.push(meta.maxAttempts);
            calls += 1;
            if (calls < 3) throw new Error(`attempt-${calls}`);
          },
          retry: { attempts: 3, delayMs: 0 },
        }),
      )
      .execute({});

    expect(result.ok).toBe(true);
    expect(attempts).toEqual([1, 2, 3]);
    expect(maxAttempts).toEqual([3, 3, 3]);
    expect(report(result, 'flaky').attempts).toBe(3);
  });

  it('reports the declared step name and the pipeline name inside a parallel group', async () => {
    const seen: string[] = [];
    const result = await new Pipeline<Ctx>('group-pipeline')
      .addParallel([
        new Step<Ctx>('left', (_ctx, meta) => {
          seen.push(`${meta.pipelineName}/${meta.stepName}`);
        }),
        new Step<Ctx>('right', (_ctx, meta) => {
          seen.push(`${meta.pipelineName}/${meta.stepName}`);
        }),
      ])
      .execute({});

    expect(result.ok).toBe(true);
    expect(seen.sort()).toEqual([
      'group-pipeline/left',
      'group-pipeline/right',
    ]);
  });

  it('describes the inner pipeline, not the outer one, inside an asStep run', async () => {
    let innerMeta: StepMeta | undefined;
    const inner = new Pipeline<InnerCtx>('inner').addStep(
      new Step<InnerCtx>('i1', (_ctx, meta) => {
        innerMeta = meta;
      }),
    );
    const outer = new Pipeline<Ctx>('outer').addStep(
      inner.asStep<Ctx>('run-inner', { mapInput: () => ({ n: 1 }) }),
    );

    const result = await outer.execute({});

    // The nested run is its own execution: its steps see the inner pipeline's
    // name and the inner executionId.
    expect(innerMeta?.stepName).toBe('i1');
    expect(innerMeta?.pipelineName).toBe('inner');
    expect(innerMeta?.executionId).not.toBe(result.executionId);
    expect(innerMeta?.executionId).toBe(
      report(result, 'run-inner').innerResult?.executionId,
    );
  });

  it('still accepts single-argument run and undo functions (no arity break)', async () => {
    const run = vi.fn((ctx: Ctx) => {
      ctx.marker = 'ran';
    });
    const undo = vi.fn(() => {});
    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('a', { run, undo }))
      .addStep(
        new Step<Ctx>('boom', () => {
          throw new Error('later failure');
        }),
      )
      .execute({});

    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.context.marker).toBe('ran');
    expect(report(result, 'a').status).toBe('rolled-back');
  });
});

describe('signal semantics (section 1.3)', () => {
  it('leaves ctx.signal unaborted by a step timeout; meta.signal carries it', async () => {
    let ctxSignal: AbortSignal | undefined;
    let metaSignal: AbortSignal | undefined;
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('slow', {
          run: (ctx, meta) => {
            ctxSignal = ctx.signal;
            metaSignal = meta.signal;
            return neverSettles();
          },
          timeout: 20,
        }),
      )
      .execute({});

    expect(result.ok).toBe(false);
    expect(report(result, 'slow').timedOut).toBe(true);
    // meta.signal is this invocation's own signal: the timeout aborts it.
    expect(metaSignal?.aborted).toBe(true);
    expect((metaSignal?.reason as Error).name).toBe('TimeoutError');
    // ctx.signal is the pipeline-level signal and is untouched (section 1.3).
    expect(ctxSignal?.aborted).toBe(false);
    expect(result.context.signal.aborted).toBe(false);
  });

  it('never reassigns ctx.signal — one object across sequential, timed, and parallel steps', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const capture = (ctx: Ctx): void => {
      seen.push(ctx.signal);
    };

    const result = await new Pipeline<Ctx>('p')
      .addStep(new Step<Ctx>('timed', { run: capture, timeout: 10_000 }))
      .addParallel([
        new Step<Ctx>('p1', { run: capture, timeout: 10_000 }),
        new Step<Ctx>('p2', capture),
      ])
      .addStep(new Step<Ctx>('after', capture))
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(4);
    // Set once at context creation; the executor never swaps it, not for a
    // per-attempt timeout and not for the duration of a parallel group.
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(controller.signal);
    expect(result.context.signal).toBe(controller.signal);
  });

  it('gives each parallel step its own meta.signal, so one step timeout never aborts a peer', async () => {
    const signals: Record<string, AbortSignal> = {};
    const result = await new Pipeline<Ctx>('p')
      .addParallel([
        new Step<Ctx>('quick', {
          run: async (_ctx, meta) => {
            signals.quick = meta.signal;
            await sleep(5);
          },
          // Fires long after 'quick' has finished but while 'long' still runs.
          timeout: 60,
        }),
        new Step<Ctx>('long', {
          run: async (_ctx, meta) => {
            signals.long = meta.signal;
            await sleep(150);
          },
          timeout: 10_000,
        }),
      ])
      .execute({});

    expect(result.ok).toBe(true);
    expect(signals.quick).toBeDefined();
    expect(signals.long).toBeDefined();
    // Distinct objects: a shared ctx.signal could not represent both.
    expect(signals.quick).not.toBe(signals.long);
    // 'quick' completed, then its own 60ms budget elapsed and aborted only
    // its own signal — the peer, still running, is untouched.
    expect(signals.quick?.aborted).toBe(true);
    expect(signals.long?.aborted).toBe(false);
  });

  it('aborts a peer meta.signal with the group reason, not the timed-out step reason', async () => {
    const signals: Record<string, AbortSignal> = {};
    const result = await new Pipeline<Ctx>('p')
      .addParallel([
        new Step<Ctx>('times-out', {
          run: (_ctx, meta) => {
            signals.timesOut = meta.signal;
            return neverSettles();
          },
          timeout: 20,
        }),
        new Step<Ctx>('peer', (_ctx, meta) => {
          signals.peer = meta.signal;
          return waitForAbort(meta.signal);
        }),
      ])
      .execute({});

    expect(result.ok).toBe(false);
    expect(signals.timesOut).not.toBe(signals.peer);
    // The timed-out step saw its own TimeoutError…
    expect((signals.timesOut?.reason as Error).name).toBe('TimeoutError');
    // …while the peer was ended by the group abort after that step failed.
    expect((signals.peer?.reason as Error).name).toBe('StepError');
    expect(report(result, 'peer').skipReason).toBe(
      'cancelled (parallel peer failed)',
    );
    expect(result.context.signal.aborted).toBe(false);
  });

  it('aborts ctx.signal and every live meta.signal when the pipeline is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel everything');
    const metaSignals: AbortSignal[] = [];

    const result = await new Pipeline<Ctx>('p')
      .addParallel([
        new Step<Ctx>('a', (_ctx, meta) => {
          metaSignals.push(meta.signal);
          setTimeout(() => controller.abort(reason), 0);
          return waitForAbort(meta.signal);
        }),
        new Step<Ctx>('b', (_ctx, meta) => {
          metaSignals.push(meta.signal);
          return waitForAbort(meta.signal);
        }),
      ])
      .execute({}, { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.error).toBe(reason);
    expect(metaSignals).toHaveLength(2);
    expect(metaSignals[0]).not.toBe(metaSignals[1]);
    for (const signal of metaSignals) {
      expect(signal.aborted).toBe(true);
      // A composite signal reports the source signal's reason verbatim.
      expect(signal.reason).toBe(reason);
    }
    expect(result.context.signal.aborted).toBe(true);
  });

  it('passes undo the pipeline signal, not the step timeout signal', async () => {
    const controller = new AbortController();
    let undoMeta: StepMeta | undefined;

    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('a', {
          run: () => {},
          undo: (_ctx, meta) => {
            undoMeta = meta;
          },
          timeout: 5000,
        }),
      )
      .addStep(
        new Step<Ctx>('boom', () => {
          throw new Error('later failure');
        }),
      )
      .execute({}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    // A compensation must be allowed to finish: it is not bound by the
    // step's per-attempt timeout (section 1.2).
    expect(undoMeta?.signal).toBe(controller.signal);
    expect(undoMeta?.signal.aborted).toBe(false);
  });
});

describe('Result additions (section 1.7)', () => {
  it('names the pipeline on the Result for success, failure, and dry-run', async () => {
    const success = await new Pipeline<Ctx>('named-pipeline')
      .addStep(new Step<Ctx>('a', () => {}))
      .execute({});
    const failure = await new Pipeline<Ctx>('named-pipeline')
      .addStep(
        new Step<Ctx>('boom', () => {
          throw new Error('x');
        }),
      )
      .execute({});
    const plan = await new Pipeline<Ctx>('named-pipeline')
      .addStep(new Step<Ctx>('a', () => {}))
      .execute({}, { dryRun: true });

    expect(success.pipelineName).toBe('named-pipeline');
    expect(failure.pipelineName).toBe('named-pipeline');
    expect(plan.pipelineName).toBe('named-pipeline');
  });

  it('measures durationMs for the whole execute call', async () => {
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('work', async () => {
          await sleep(20);
        }),
      )
      .execute({});

    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('includes rollback time in durationMs', async () => {
    const result = await new Pipeline<Ctx>('p')
      .addStep(
        new Step<Ctx>('a', {
          run: () => {},
          undo: async () => {
            await sleep(40);
          },
        }),
      )
      .addStep(
        new Step<Ctx>('boom', () => {
          throw new Error('x');
        }),
      )
      .execute({});

    expect(result.ok).toBe(false);
    expect(report(result, 'a').status).toBe('rolled-back');
    // The failing step itself is instant; only the compensation takes time,
    // so a duration this long can only come from rollback being included.
    expect(result.durationMs).toBeGreaterThanOrEqual(35);
  });

  it('reports durationMs on an empty pipeline as a non-negative number', async () => {
    const result = await new Pipeline<Ctx>('empty').execute({});

    expect(result.ok).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
