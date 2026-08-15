import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { Engine } from '../src/engine';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { serializeResult } from '../src/serialize';
import { Step } from '../src/step';
import type { Result, Tracer } from '../src/types';

// The names that must be rejected everywhere a name is accepted (section 1.10).
const RESERVED = ['__proto__', 'prototype', 'constructor'];

describe('security invariants (section 1.10)', () => {
  describe('reserved-name rejection', () => {
    it.each(RESERVED)('rejects an engine named "%s"', (name) => {
      expect(() => new Engine(name, { m() {} })).toThrow(UsageError);
    });

    it.each(RESERVED)('rejects a step named "%s"', (name) => {
      expect(() => new Step(name, () => {})).toThrow(UsageError);
    });

    it.each(RESERVED)('rejects a pipeline named "%s"', (name) => {
      expect(() => new Pipeline(name)).toThrow(UsageError);
    });
  });

  it('does not pollute Object.prototype when reserved names are rejected', () => {
    for (const name of RESERVED) {
      expect(() => new Engine(name, { m() {} })).toThrow(UsageError);
      expect(() => new Step(name, () => {})).toThrow(UsageError);
      expect(() => new Pipeline(name)).toThrow(UsageError);
    }

    // Canary: none of the rejected constructions leaked onto Object.prototype.
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it('uses a Map-backed engine accessor that never leaks Object.prototype members', async () => {
    // A plain-object registry would surface Object.prototype.hasOwnProperty here;
    // the Map-backed accessor instead reports it as an unknown engine (section 1.10).
    const result = await new Pipeline('proto-leak')
      .addStep(
        new Step('reads-builtin', (ctx) => {
          void ctx.engines.hasOwnProperty;
        }),
      )
      .execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).cause).toBeInstanceOf(UsageError);
  });

  describe('serialization hygiene (0.4.0 section 1.6)', () => {
    it('never puts the context — or its input — in the output unless asked', async () => {
      const result = await new Pipeline('secrets')
        .addStep(new Step('a', () => {}))
        .execute({ apiKey: 'sk_live_do_not_log' });

      const serialized = serializeResult(result);
      expect('context' in serialized).toBe(false);
      // Same invariant as the logger: payloads never leave the process by
      // default, only names, statuses, durations, and error types/messages.
      expect(JSON.stringify(serialized)).not.toContain('sk_live_do_not_log');
    });

    it('never puts a context or input value in a trace attribute (0.4.0 section 1.8)', async () => {
      const attributes: [string, string | number | boolean][] = [];
      const names: string[] = [];
      const tracer: Tracer = {
        startSpan(name) {
          names.push(name);
          return {
            setAttribute(key, value) {
              attributes.push([key, value]);
            },
            recordException() {},
            setStatus() {},
            end() {},
          };
        },
      };

      await new Pipeline('traced')
        .addStep(
          new Step('a', (ctx) => {
            (ctx as { copied?: string }).copied = (
              ctx.input as { apiKey: string }
            ).apiKey;
          }),
        )
        .execute({ apiKey: 'sk_live_do_not_trace' }, { tracer });

      // Same invariant as the logger and the serializer: only names, ids,
      // statuses, counts and durations ever leave the process.
      expect(attributes.length).toBeGreaterThan(0);
      const rendered = JSON.stringify({ names, attributes });
      expect(rendered).not.toContain('sk_live_do_not_trace');
    });

    it('does not pollute Object.prototype through a __proto__ error property', () => {
      const error = new Error('hostile');
      // Assignment would reassign the prototype; defineProperty makes it a
      // genuine own key, which is what a hostile payload would look like.
      Object.defineProperty(error, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const result: Result<BaseContext> = {
        ok: false,
        context: {} as BaseContext,
        steps: [],
        error,
        rollbackErrors: [],
        aborted: false,
        executionId: 'exec-1',
        pipelineName: 'p',
        durationMs: 1,
      };

      const serialized = serializeResult(result);

      // The key survives as data on the output, not as a prototype swap.
      expect(Object.getPrototypeOf(serialized.error)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(serialized.error, '__proto__')?.value,
      ).toEqual({ polluted: true });
      // Canary: nothing reached Object.prototype.
      const probe = {} as Record<string, unknown>;
      expect(probe.polluted).toBeUndefined();
      expect(
        (Object.prototype as Record<string, unknown>).polluted,
      ).toBeUndefined();
    });
  });
});
