import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/errors';
import { assertSafeName, describeError } from '../src/internal';

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

describe('describeError', () => {
  it('reports an Error by its name and message', () => {
    expect(describeError(new TypeError('bad input'))).toEqual({
      errorType: 'TypeError',
      errorMessage: 'bad input',
    });
  });

  it.each([
    ['a string', 'boom', 'string', 'boom'],
    ['a number', 42, 'number', '42'],
    ['null', null, 'object', 'null'],
    ['undefined', undefined, 'undefined', 'undefined'],
  ])(
    'reports %s by its typeof and coerced text',
    (_label, thrown, type, text) => {
      expect(describeError(thrown)).toEqual({
        errorType: type,
        errorMessage: text,
      });
    },
  );

  it('degrades a value that refuses string coercion instead of throwing', () => {
    // A null-prototype object has no toString, so String() on it throws. This
    // function sits on the step-failure logging path, so an escape here would
    // turn an operational failure into a rejected execute() (section 1.1).
    expect(describeError(Object.create(null))).toEqual({
      errorType: 'object',
      errorMessage: '[uncoercible value]',
    });

    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('refuses coercion');
      },
    };
    expect(describeError(hostile)).toEqual({
      errorType: 'object',
      errorMessage: '[uncoercible value]',
    });
  });
});
