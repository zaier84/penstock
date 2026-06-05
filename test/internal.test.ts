import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/errors';
import { assertSafeName } from '../src/internal';

describe('assertSafeName', () => {
  it('accepts an ordinary non-empty name', () => {
    expect(() => assertSafeName('Step', 'validate-order')).not.toThrow();
  });

  it('rejects an empty string with a UsageError', () => {
    expect(() => assertSafeName('Step', '')).toThrow(UsageError);
  });

  it('rejects a non-string name with a UsageError', () => {
    expect(() => assertSafeName('Pipeline', 123)).toThrow(UsageError);
    expect(() => assertSafeName('Pipeline', undefined)).toThrow(UsageError);
    expect(() => assertSafeName('Pipeline', null)).toThrow(UsageError);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects the reserved name %s with a UsageError',
    (name) => {
      expect(() => assertSafeName('Engine', name)).toThrow(UsageError);
    },
  );

  it('names the entity kind in the error message', () => {
    expect(() => assertSafeName('UseCase', '')).toThrow(/UseCase/);
  });
});
