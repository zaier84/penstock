import { inspect } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import {
  Engine,
  clearEngines,
  createEngineAccessor,
  registerEngine,
} from '../src/engine';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { EngineMethods } from '../src/types';

interface DemoInput {
  id: string;
}

interface DemoCtx extends BaseContext<DemoInput> {
  // Engine methods return `unknown` (section 3.5); tests capture results loosely.
  sum?: unknown;
  value?: unknown;
}

// The global registry is process-wide mutable state (section 3.5); reset between tests.
afterEach(() => {
  clearEngines();
});

describe('Engine', () => {
  describe('construction', () => {
    it('builds with a name and a methods bundle', () => {
      const engine = new Engine('math', {
        add(x: number, y: number) {
          return x + y;
        },
      });

      expect(engine.name).toBe('math');
    });

    it('rejects an empty or non-string name', () => {
      expect(() => new Engine('', { m() {} })).toThrow(UsageError);
      expect(() => new Engine(123 as unknown as string, { m() {} })).toThrow(
        UsageError,
      );
    });

    it('rejects a null methods bundle', () => {
      expect(() => new Engine('e', null as unknown as EngineMethods)).toThrow(
        UsageError,
      );
    });

    it('rejects a non-object methods bundle', () => {
      expect(() => new Engine('e', 42 as unknown as EngineMethods)).toThrow(
        UsageError,
      );
    });

    it('rejects an empty methods bundle', () => {
      expect(() => new Engine('e', {})).toThrow(UsageError);
    });

    it('rejects a methods bundle containing a non-function', () => {
      expect(
        () => new Engine('e', { bad: 1 } as unknown as EngineMethods),
      ).toThrow(UsageError);
    });
  });

  describe('global registry', () => {
    it('registers an engine and a step can call it via ctx.engines', async () => {
      registerEngine(
        new Engine('adder', {
          add(x: number, y: number) {
            return x + y;
          },
        }),
      );

      const result = await new Pipeline<DemoCtx>('p')
        .addStep(
          new Step<DemoCtx>('sum', (ctx) => {
            ctx.sum = ctx.engines.adder!.add!(2, 3);
          }),
        )
        .execute({ id: 'x' });

      expect(result.ok).toBe(true);
      expect(result.context.sum).toBe(5);
    });

    it('throws a UsageError when re-registering the same name', () => {
      registerEngine(new Engine('dup', { m() {} }));

      expect(() => registerEngine(new Engine('dup', { m() {} }))).toThrow(
        UsageError,
      );
    });

    it('clearEngines() resets the registry so the engine becomes unknown', async () => {
      registerEngine(new Engine('temp', { m() {} }));
      clearEngines();

      const result = await new Pipeline<DemoCtx>('p')
        .addStep(
          new Step<DemoCtx>('s', (ctx) => {
            void ctx.engines.temp;
          }),
        )
        .execute({ id: 'x' });

      expect(result.ok).toBe(false);
      expect((result.error as StepError).cause).toBeInstanceOf(UsageError);
    });
  });

  describe('resolution', () => {
    it('resolves a pipeline-scoped engine registered via useEngine', async () => {
      const result = await new Pipeline<DemoCtx>('scoped')
        .useEngine(
          new Engine('local', {
            greet() {
              return 'hi';
            },
          }),
        )
        .addStep(
          new Step<DemoCtx>('s', (ctx) => {
            ctx.value = ctx.engines.local!.greet!();
          }),
        )
        .execute({ id: 'x' });

      expect(result.context.value).toBe('hi');
    });

    it('lets a pipeline-scoped engine shadow a global one of the same name', async () => {
      registerEngine(
        new Engine('pricing', {
          rate() {
            return 1;
          },
        }),
      );

      const result = await new Pipeline<DemoCtx>('shadow')
        .useEngine(
          new Engine('pricing', {
            rate() {
              return 99;
            },
          }),
        )
        .addStep(
          new Step<DemoCtx>('s', (ctx) => {
            ctx.value = ctx.engines.pricing!.rate!();
          }),
        )
        .execute({ id: 'x' });

      expect(result.context.value).toBe(99);
    });

    it('throws a UsageError (not a bare TypeError) on an unknown engine', async () => {
      const result = await new Pipeline<DemoCtx>('unknown')
        .addStep(
          new Step<DemoCtx>('s', (ctx) => {
            void ctx.engines.nope;
          }),
        )
        .execute({ id: 'x' });

      expect(result.ok).toBe(false);
      const cause = (result.error as StepError).cause;
      expect(cause).toBeInstanceOf(UsageError);
      expect((cause as Error).message).toContain('nope');
    });
  });

  describe('accessor robustness', () => {
    it('returns undefined for symbol-keyed access instead of throwing', () => {
      const engines = createEngineAccessor(new Map());
      const probe = engines as unknown as Record<symbol, unknown>;

      expect(probe[Symbol.toStringTag]).toBeUndefined();
      expect(probe[Symbol.iterator]).toBeUndefined();
    });

    it('can be inspected without throwing (console.log(ctx) safety)', () => {
      const engines = createEngineAccessor(new Map());

      // Node's inspector probes well-known symbols; none must throw (section 3.5).
      expect(() => inspect(engines)).not.toThrow();
    });

    it('still throws a UsageError for an unknown string name', () => {
      const engines = createEngineAccessor(new Map());

      expect(() => (engines as Record<string, unknown>).nope).toThrow(
        UsageError,
      );
    });
  });
});
