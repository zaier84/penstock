import { describe, expect, it } from 'vitest';

import { Engine } from '../src/engine';
import { StepError, UsageError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';

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
});
