import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { PipelineError, StepError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { serializeResult } from '../src/serialize';
import { Step } from '../src/step';
import type {
  Result,
  SerializedError,
  SerializedResult,
  StepReport,
} from '../src/types';

interface Input {
  orderId: string;
  secret?: string;
}

interface Ctx extends BaseContext<Input> {
  total?: number;
}

const input: Input = { orderId: 'ord_1', secret: 'tok_live_123' };

/**
 * A plain `Result` literal, for shapes a real run cannot easily produce (an
 * `AggregateError` as `result.error`, a hostile custom property). Mirrors the
 * helper in `errors.test.ts`.
 */
function makeResult(
  overrides: Partial<Result<BaseContext>> = {},
): Result<BaseContext> {
  return {
    ok: true,
    context: {} as BaseContext,
    steps: [],
    error: null,
    rollbackErrors: [],
    aborted: false,
    executionId: 'exec-1',
    pipelineName: 'p',
    durationMs: 1.5,
    ...overrides,
  };
}

/** Every terminal outcome a pipeline can reach, for the round-trip sweep. */
async function outcomes(): Promise<{ label: string; result: Result<Ctx> }[]> {
  const success = await new Pipeline<Ctx>('success')
    .addStep(
      new Step<Ctx>('a', (ctx) => {
        ctx.total = 1;
      }),
    )
    .execute(input);

  const failure = await new Pipeline<Ctx>('failure')
    .addStep(new Step<Ctx>('a', () => {}))
    .addStep(
      new Step<Ctx>('boom', () => {
        throw new Error('nope');
      }),
    )
    .execute(input);

  const rollbackFailed = await new Pipeline<Ctx>('rollback')
    .addStep(
      new Step<Ctx>('a', {
        run: () => {},
        undo: () => {
          throw new Error('undo failed');
        },
      }),
    )
    .addStep(
      new Step<Ctx>('boom', () => {
        throw new Error('nope');
      }),
    )
    .execute(input);

  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  const cancelled = await new Pipeline<Ctx>('cancelled')
    .addStep(new Step<Ctx>('a', () => {}))
    .execute(input, { signal: controller.signal });

  const dryRun = await new Pipeline<Ctx>('dry')
    .addStep(new Step<Ctx>('a', () => {}))
    .addStep(new Step<Ctx>('b', { run: () => {}, when: () => false }))
    .execute(input, { dryRun: true });

  const empty = await new Pipeline<Ctx>('empty').execute(input);

  return [
    { label: 'success', result: success },
    { label: 'step failure', result: failure },
    { label: 'rollback with rollbackErrors', result: rollbackFailed },
    { label: 'cancellation', result: cancelled },
    { label: 'dry-run', result: dryRun },
    { label: 'empty pipeline', result: empty },
  ];
}

describe('serializeResult (section 1.6)', () => {
  describe('JSON safety', () => {
    it('survives JSON.stringify for every outcome', async () => {
      for (const { label, result } of await outcomes()) {
        const serialized = serializeResult(result);
        expect(() => JSON.stringify(serialized), label).not.toThrow();

        const parsed = JSON.parse(
          JSON.stringify(serialized),
        ) as SerializedResult;
        expect(parsed.ok, label).toBe(result.ok);
        expect(parsed.aborted, label).toBe(result.aborted);
        expect(parsed.executionId, label).toBe(result.executionId);
        expect(parsed.pipelineName, label).toBe(result.pipelineName);
        expect(parsed.durationMs, label).toBe(result.durationMs);
        expect(
          parsed.steps.map((s) => s.name),
          label,
        ).toEqual(result.steps.map((s) => s.name));
        expect(parsed.rollbackErrors.length, label).toBe(
          result.rollbackErrors.length,
        );
        // Errors are objects with real content, not the `{}` that
        // JSON.stringify produces for an Error.
        if (result.error !== null) {
          expect(parsed.error?.message, label).toBe(result.error.message);
        } else {
          expect(parsed.error, label).toBeNull();
        }
      }
    });

    it('keeps the rollback failures as serialized errors', async () => {
      const [, , rollback] = await outcomes();
      const serialized = serializeResult(rollback!.result);

      expect(serialized.ok).toBe(false);
      expect(serialized.rollbackErrors).toHaveLength(1);
      expect(serialized.rollbackErrors[0]?.name).toBe('Error');
      expect(serialized.rollbackErrors[0]?.message).toBe('undo failed');
      expect(serialized.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
        'a:rollback-failed',
        'boom:failed',
      ]);
    });

    it('serializes a dry-run plan and an empty pipeline', async () => {
      const [, , , , dryRun, empty] = await outcomes();
      const plan = serializeResult(dryRun!.result);
      expect(plan.ok).toBe(true);
      expect(plan.error).toBeNull();
      expect(plan.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
        'a:would-run',
        'b:skipped',
      ]);
      expect(plan.steps[1]?.skipReason).toBe('guard returned false');

      const none = serializeResult(empty!.result);
      expect(none.steps).toEqual([]);
      expect(none.rollbackErrors).toEqual([]);
    });
  });

  describe('context (excluded by default)', () => {
    it('omits the context and everything in it unless asked', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('a', (ctx) => {
            ctx.total = 42;
          }),
        )
        .execute(input);

      const serialized = serializeResult(result);
      expect('context' in serialized).toBe(false);
      expect(serialized.context).toBeUndefined();
      // The whole point: no payload reaches the log aggregator.
      expect(JSON.stringify(serialized)).not.toContain('tok_live_123');
    });

    it('includes the context, best-effort, with includeContext: true', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('a', (ctx) => {
            ctx.total = 42;
          }),
        )
        .execute(input);

      const serialized = serializeResult(result, { includeContext: true });
      expect('context' in serialized).toBe(true);
      const ctx = serialized.context as Record<string, unknown>;
      expect(ctx.input).toEqual(input);
      expect(ctx.total).toBe(42);
      expect(ctx.executionId).toBe(result.executionId);
      // The non-data members of a context degrade rather than crash: the
      // engine accessor throws on every unknown property read, and a logger
      // is a bag of functions.
      expect(() => JSON.stringify(serialized)).not.toThrow();
      expect(JSON.stringify(serialized)).toContain('tok_live_123');
    });
  });

  describe('error flattening', () => {
    it('flattens an error to name, message, and stack', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute(input);

      const error = serializeResult(result).error as SerializedError;
      expect(error.name).toBe('StepError');
      expect(error.message).toBe('Step "boom" failed');
      expect(typeof error.stack).toBe('string');
      expect(error.stack).toContain('StepError');
      const cause = error.cause as SerializedError;
      expect(cause.name).toBe('Error');
      expect(cause.message).toBe('nope');
    });

    it('omits stacks at every level when includeStacks is false', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              throw new Error('undo failed');
            },
          }),
        )
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute(input);

      const serialized = serializeResult(result, { includeStacks: false });
      const error = serialized.error as SerializedError;
      expect('stack' in error).toBe(false);
      expect('stack' in (error.cause as SerializedError)).toBe(false);
      expect('stack' in serialized.rollbackErrors[0]!).toBe(false);
      expect('stack' in (serialized.steps[1]?.error as SerializedError)).toBe(
        false,
      );
      // Nothing else was lost with the stacks.
      expect(error.name).toBe('StepError');
      expect(error.stepName).toBe('boom');
    });
  });

  describe('cause chains', () => {
    const chain = (): Error => {
      const depth4 = new Error('depth-4');
      const depth3 = new Error('depth-3', { cause: depth4 });
      const depth2 = new Error('depth-2', { cause: depth3 });
      return new Error('depth-1', { cause: depth2 });
    };

    /** Walks the serialized cause chain, newest first. */
    const messages = (error: SerializedError): string[] => {
      const out: string[] = [];
      let current: SerializedError | undefined = error;
      while (current !== undefined) {
        out.push(current.message);
        current = current.cause;
      }
      return out;
    };

    it('follows the whole chain by default (maxCauseDepth 5)', () => {
      const serialized = serializeResult(
        makeResult({ ok: false, error: chain() }),
      );
      expect(messages(serialized.error as SerializedError)).toEqual([
        'depth-1',
        'depth-2',
        'depth-3',
        'depth-4',
      ]);
    });

    it('truncates cleanly at maxCauseDepth', () => {
      const serialized = serializeResult(
        makeResult({ ok: false, error: chain() }),
        { maxCauseDepth: 2 },
      );
      const error = serialized.error as SerializedError;
      expect(messages(error)).toEqual(['depth-1', 'depth-2', 'depth-3']);
      // Truncation is the absence of the key, not a placeholder node.
      const deepest = error.cause?.cause as SerializedError;
      expect('cause' in deepest).toBe(false);
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('follows no causes at all with maxCauseDepth 0', () => {
      const serialized = serializeResult(
        makeResult({ ok: false, error: chain() }),
        { maxCauseDepth: 0 },
      );
      const error = serialized.error as SerializedError;
      expect(error.message).toBe('depth-1');
      expect('cause' in error).toBe(false);
    });
  });

  describe('custom error properties', () => {
    it('preserves StepError.stepName', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('charge-payment', () => {
            throw new Error('declined');
          }),
        )
        .execute(input);

      const error = serializeResult(result).error as SerializedError;
      expect(error.stepName).toBe('charge-payment');
    });

    it("preserves a user's own error fields, including nested objects", async () => {
      class PaymentError extends Error {
        readonly declineCode: string;
        readonly gateway: { id: string; retryable: boolean };

        constructor(message: string) {
          super(message);
          this.name = 'PaymentError';
          this.declineCode = 'insufficient_funds';
          this.gateway = { id: 'gw_1', retryable: false };
        }
      }

      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('charge', () => {
            throw new PaymentError('card declined');
          }),
        )
        .execute(input);

      const cause = (serializeResult(result).error as SerializedError)
        .cause as SerializedError;
      expect(cause.name).toBe('PaymentError');
      expect(cause.message).toBe('card declined');
      expect(cause.declineCode).toBe('insufficient_funds');
      expect(cause.gateway).toEqual({ id: 'gw_1', retryable: false });
    });

    it('serializes AggregateError.errors as an array', () => {
      const aggregate = new AggregateError(
        [new Error('one'), new StepError('two')],
        'several failed',
      );
      const serialized = serializeResult(
        makeResult({ ok: false, error: aggregate }),
      );

      const error = serialized.error as SerializedError;
      expect(error.name).toBe('AggregateError');
      expect(error.message).toBe('several failed');
      const errors = error.errors as SerializedError[];
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.map((e) => e.name)).toEqual(['Error', 'StepError']);
      expect(errors[0]?.message).toBe('one');
      expect(errors[1]?.stepName).toBe('two');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it("serializes a PipelineError's nested error fields", () => {
      const stepError = new StepError('boom', { cause: new Error('nope') });
      const inner = makeResult({
        ok: false,
        error: stepError,
        pipelineName: 'inner',
      });
      const error = new PipelineError('Pipeline "inner" failed', {
        result: inner,
        cause: stepError,
        rollbackErrors: new AggregateError(
          [new Error('undo failed')],
          'Pipeline "inner" rollback failed',
        ),
      });

      const serialized = serializeResult(makeResult({ ok: false, error }));
      const out = serialized.error as SerializedError;
      expect(out.name).toBe('PipelineError');
      // An Error held as a custom property is itself flattened, not walked
      // as a bare object — so the AggregateError keeps its errors array.
      const bundle = out.rollbackErrors as SerializedError;
      expect(bundle.name).toBe('AggregateError');
      expect(
        (bundle.errors as SerializedError[]).map((e) => e.message),
      ).toEqual(['undo failed']);
      expect((out.result as SerializedResult).pipelineName).toBe('inner');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('tolerates an AggregateError whose errors is not an array', () => {
      const error = new AggregateError([new Error('one')], 'several');
      Object.defineProperty(error, 'errors', {
        value: 'not-an-array',
        writable: true,
        configurable: true,
      });

      const out = serializeResult(makeResult({ ok: false, error }))
        .error as SerializedError;
      expect(out.name).toBe('AggregateError');
      expect(out.errors).toEqual([]);
    });

    it('serializes a nested PipelineError result without leaking its context', async () => {
      const inner = new Pipeline<Ctx>('inner').addStep(
        new Step<Ctx>('inner-boom', () => {
          throw new Error('inner failed');
        }),
      );
      const result = await new Pipeline<Ctx>('outer')
        .addStep(
          new Step<Ctx>('run-inner', async () => {
            await inner.execute(
              { orderId: 'ord_inner', secret: 'inner_secret' },
              { throwOnError: true },
            );
          }),
        )
        .execute(input);

      const serialized = serializeResult(result);
      const cause = (serialized.error as SerializedError)
        .cause as SerializedError;
      expect(cause.name).toBe('PipelineError');
      const nested = cause.result as SerializedResult;
      expect(nested.pipelineName).toBe('inner');
      expect(nested.ok).toBe(false);
      expect(nested.steps.map((s) => s.name)).toEqual(['inner-boom']);
      // The nested Result obeys the same context rule as the outer one.
      expect('context' in nested).toBe(false);
      expect(JSON.stringify(serialized)).not.toContain('inner_secret');

      const withContext = serializeResult(result, { includeContext: true });
      const nestedWithContext = (
        (withContext.error as SerializedError).cause as SerializedError
      ).result as SerializedResult;
      expect('context' in nestedWithContext).toBe(true);
    });
  });

  describe('non-Error throws', () => {
    it.each([
      ['a string', 'boom', 'boom'],
      ['a number', 42, '42'],
      ['null', null, 'null'],
      ['undefined', undefined, 'undefined'],
    ])('serializes %s as UnknownError', async (_label, thrown, message) => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw thrown;
          }),
        )
        .execute(input);

      const serialized = serializeResult(result);
      const cause = (serialized.error as SerializedError)
        .cause as SerializedError;
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe(message);
      expect('stack' in cause).toBe(false);
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('serializes a thrown value that cannot even be stringified', () => {
      // A null-prototype object throws on String() coercion. The Result is
      // built directly here so the case exercises the serializer alone.
      const error = new StepError('boom', {
        cause: Object.create(null) as object,
      });
      const serialized = serializeResult(makeResult({ ok: false, error }));

      const cause = (serialized.error as SerializedError)
        .cause as SerializedError;
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('[Unserializable]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });
  });

  describe('circular references', () => {
    it('replaces a circular error property with [Circular]', () => {
      const error = new Error('cyclic') as Error & {
        details?: Record<string, unknown>;
      };
      const details: Record<string, unknown> = { id: 'x' };
      details.self = details;
      error.details = details;

      const serialized = serializeResult(makeResult({ ok: false, error }));
      const details2 = (serialized.error as SerializedError).details as Record<
        string,
        unknown
      >;
      expect(details2.id).toBe('x');
      expect(details2.self).toBe('[Circular]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('replaces a circular context value with [Circular] when included', async () => {
      interface CycleCtx extends BaseContext<Input> {
        self?: unknown;
      }
      const result = await new Pipeline<CycleCtx>('p')
        .addStep(
          new Step<CycleCtx>('a', (ctx) => {
            ctx.self = ctx;
          }),
        )
        .execute(input);

      const serialized = serializeResult(result, { includeContext: true });
      const ctx = serialized.context as Record<string, unknown>;
      expect(ctx.self).toBe('[Circular]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('serializes a shared (non-circular) error in full at every occurrence', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute(input);

      // penstock stores the identical StepError on both the report and the
      // Result; a shared reference is not a cycle and must not be collapsed.
      expect(result.steps[0]?.error).toBe(result.error);
      const serialized = serializeResult(result);
      const top = serialized.error as SerializedError;
      const onStep = serialized.steps[0]?.error as SerializedError;
      expect(onStep.name).toBe('StepError');
      expect(onStep.message).toBe(top.message);
      expect(onStep.stepName).toBe('boom');
      expect((onStep.cause as SerializedError).message).toBe('nope');
    });

    it('stops at an error that is its own cause', () => {
      const error = new Error('self-caused');
      Object.defineProperty(error, 'cause', {
        value: error,
        writable: true,
        configurable: true,
      });

      const serialized = serializeResult(makeResult({ ok: false, error }));
      const out = serialized.error as SerializedError;
      expect(out.message).toBe('self-caused');
      // The name is kept so the cycle is still identifiable in a log.
      expect(out.cause?.name).toBe('Error');
      expect(out.cause?.message).toBe('[Circular]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('marks a PipelineError whose result is the one being serialized', () => {
      const result = makeResult({ ok: false });
      result.error = new PipelineError('Pipeline "p" failed', { result });

      const serialized = serializeResult(result);
      expect((serialized.error as SerializedError).result).toBe('[Circular]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('does not recurse forever on a self-referential innerResult', () => {
      const report: StepReport = {
        name: 'wrapper',
        status: 'completed',
        durationMs: 1,
      };
      const result = makeResult({ steps: [report] });
      report.innerResult = result;

      const serialized = serializeResult(result);
      expect('innerResult' in serialized.steps[0]!).toBe(false);
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });
  });

  describe('hostile values', () => {
    it('degrades a throwing getter, a throwing ownKeys, and a throwing toJSON', () => {
      const error = new Error('hostile');
      Object.defineProperty(error, 'exploding', {
        get() {
          throw new Error('getter boom');
        },
        enumerable: true,
        configurable: true,
      });
      const hostile = error as Error & {
        opaque?: unknown;
        rendered?: unknown;
      };
      hostile.opaque = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys boom');
          },
        },
      );
      hostile.rendered = {
        toJSON() {
          throw new Error('toJSON boom');
        },
      };

      const serialized = serializeResult(makeResult({ ok: false, error }));
      const out = serialized.error as SerializedError;
      expect(out.exploding).toBe('[Unserializable]');
      expect(out.opaque).toEqual({});
      expect(out.rendered).toBe('[Unserializable]');
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('renders values JSON cannot hold, and honours toJSON where it works', () => {
      const error = new Error('mixed') as Error & Record<string, unknown>;
      error.big = 10n;
      error.tag = Symbol('tag');
      error.callback = () => {};
      error.when = new Date('2024-01-02T03:04:05.000Z');
      error.list = [1, 'two', undefined, null];

      const out = serializeResult(makeResult({ ok: false, error }))
        .error as SerializedError;
      expect(out.big).toBe('[Unserializable]');
      expect(out.tag).toBe('[Unserializable]');
      expect(out.callback).toBe('[Unserializable]');
      expect(out.when).toBe('2024-01-02T03:04:05.000Z');
      expect(out.list).toEqual([1, 'two', undefined, null]);
    });
  });

  describe('nested pipelines', () => {
    it('recursively serializes innerResult with the same options', async () => {
      interface InnerInput {
        sku: string;
      }
      type InnerCtx = BaseContext<InnerInput>;
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', () => {}),
      );

      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          inner.asStep<Ctx>('run-inventory', {
            mapInput: (outer) => ({ sku: outer.input.orderId }),
          }),
        )
        .execute(input);

      const serialized = serializeResult(result);
      const nested = serialized.steps[0]?.innerResult as SerializedResult;
      expect(nested.pipelineName).toBe('inventory');
      expect(nested.ok).toBe(true);
      expect(nested.executionId).toBe(
        result.steps[0]?.innerResult?.executionId,
      );
      expect(nested.steps.map((s) => s.name)).toEqual(['reserve']);
      // The inner run is a separate execution with its own id.
      expect(nested.executionId).not.toBe(serialized.executionId);
      expect('context' in nested).toBe(false);
      expect(() => JSON.stringify(serialized)).not.toThrow();

      const withContext = serializeResult(result, { includeContext: true });
      const nestedWithContext = withContext.steps[0]
        ?.innerResult as SerializedResult;
      expect('context' in nestedWithContext).toBe(true);
      expect(
        (nestedWithContext.context as Record<string, unknown>).input,
      ).toEqual({ sku: 'ord_1' });
    });

    it('carries includeStacks into a failing innerResult', async () => {
      interface InnerInput {
        sku: string;
      }
      type InnerCtx = BaseContext<InnerInput>;
      const inner = new Pipeline<InnerCtx>('inventory').addStep(
        new Step<InnerCtx>('reserve', () => {
          throw new Error('out of stock');
        }),
      );

      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          inner.asStep<Ctx>('run-inventory', {
            mapInput: (outer) => ({ sku: outer.input.orderId }),
          }),
        )
        .execute(input);

      const serialized = serializeResult(result, { includeStacks: false });
      const nested = serialized.steps[0]?.innerResult as SerializedResult;
      expect(nested.ok).toBe(false);
      expect('stack' in (nested.error as SerializedError)).toBe(false);
      expect('stack' in (nested.steps[0]?.error as SerializedError)).toBe(
        false,
      );
      expect((nested.error as SerializedError).stepName).toBe('reserve');
    });
  });

  describe('0.4.0 result fields', () => {
    it('carries executionId, pipelineName, durationMs, aborted, and idempotencyKey', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('charge', {
            run: () => {},
            idempotencyKey: 'fixed-key',
            retry: { attempts: 2 },
          }),
        )
        .execute(input);

      const serialized = serializeResult(result);
      expect(serialized.executionId).toBe(result.executionId);
      expect(serialized.pipelineName).toBe('orders');
      expect(serialized.durationMs).toBe(result.durationMs);
      expect(serialized.aborted).toBe(false);
      const step = serialized.steps[0]!;
      expect(step.idempotencyKey).toBe('fixed-key');
      expect(step.attempts).toBe(1);
      expect(step.durationMs).toBe(result.steps[0]?.durationMs);
    });

    it('reports a cancelled run with aborted true and the raw abort reason', async () => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      controller.abort(reason);
      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute(input, { signal: controller.signal });

      const serialized = serializeResult(result);
      expect(serialized.aborted).toBe(true);
      expect(serialized.ok).toBe(false);
      // The abort reason surfaces unwrapped, exactly as on the Result.
      expect((serialized.error as SerializedError).name).toBe('Error');
      expect((serialized.error as SerializedError).message).toBe(
        'caller cancelled',
      );
      expect(serialized.steps[0]?.skipReason).toBe('cancelled');
    });

    it('omits optional step fields that are absent', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(new Step<Ctx>('a', () => {}))
        .execute(input);

      const step = serializeResult(result).steps[0]!;
      expect('error' in step).toBe(false);
      expect('skipReason' in step).toBe(false);
      expect('timedOut' in step).toBe(false);
      expect('innerResult' in step).toBe(false);
    });

    it('records timedOut on a step killed by its timeout', async () => {
      const result = await new Pipeline<Ctx>('orders')
        .addStep(
          new Step<Ctx>('slow', {
            run: () => new Promise<void>(() => {}),
            timeout: 10,
          }),
        )
        .execute(input);

      const step = serializeResult(result).steps[0]!;
      expect(step.status).toBe('failed');
      expect(step.timedOut).toBe(true);
      expect((step.error as SerializedError).name).toBe('StepError');
    });
  });

  describe('purity', () => {
    it('leaves a plain Result deep-equal to a clone of itself', () => {
      const result = makeResult({
        ok: false,
        error: new Error('boom'),
        rollbackErrors: [new Error('undo failed')],
        steps: [
          {
            name: 'a',
            status: 'failed',
            durationMs: 1,
            error: new Error('boom'),
            attempts: 2,
            idempotencyKey: 'k',
          },
        ],
        context: { input: { orderId: 'ord_1' } } as unknown as BaseContext,
      });
      const clone = structuredClone(result);

      serializeResult(result, { includeContext: true });

      expect(result).toEqual(clone);
    });

    it('adds no property, and no toJSON, to a real Result', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('a', {
            run: () => {},
            undo: () => {
              throw new Error('undo failed');
            },
          }),
        )
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute(input);

      const before = {
        keys: Object.keys(result).sort(),
        steps: result.steps.map((s) => ({ ...s })),
        stepKeys: result.steps.map((s) => Object.keys(s).sort()),
        errorKeys: Object.keys(result.error as Error).sort(),
        rollbackErrors: [...result.rollbackErrors],
        contextKeys: Object.keys(result.context).sort(),
      };
      const stepsRef = result.steps;
      const errorRef = result.error;

      serializeResult(result, {
        includeContext: true,
        includeStacks: false,
        maxCauseDepth: 1,
      });

      expect(Object.keys(result).sort()).toEqual(before.keys);
      expect(result.steps).toBe(stepsRef);
      expect(result.error).toBe(errorRef);
      expect(result.steps.map((s) => ({ ...s }))).toEqual(before.steps);
      expect(result.steps.map((s) => Object.keys(s).sort())).toEqual(
        before.stepKeys,
      );
      expect(Object.keys(result.error as Error).sort()).toEqual(
        before.errorKeys,
      );
      expect(result.rollbackErrors).toEqual(before.rollbackErrors);
      expect(Object.keys(result.context).sort()).toEqual(before.contextKeys);
      // The reason this is a function and not Result.toJSON(): the Result
      // stays a plain data object (section 1.6).
      expect('toJSON' in result).toBe(false);
      expect(result.steps.some((s) => 'toJSON' in s)).toBe(false);
    });

    it('returns independent output for repeated calls on one Result', async () => {
      const result = await new Pipeline<Ctx>('p')
        .addStep(
          new Step<Ctx>('boom', () => {
            throw new Error('nope');
          }),
        )
        .execute(input);

      const first = serializeResult(result);
      const second = serializeResult(result);
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });
});
