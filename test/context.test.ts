import { describe, expect, it } from 'vitest';

import { createContext } from '../src/context';
import { noopLogger } from '../src/logger';
import type { EngineAccessor } from '../src/types';

const engines = {} as EngineAccessor;

describe('createContext', () => {
  it('assembles a context exposing input, engines, and logger', () => {
    const input = { items: ['a', 'b'] };
    const ctx = createContext(input, engines, noopLogger);
    expect(ctx.input).toBe(input);
    expect(ctx.engines).toBe(engines);
    expect(ctx.logger).toBe(noopLogger);
  });

  it('pins input as a non-writable own property', () => {
    const ctx = createContext({ a: 1 }, engines, noopLogger);
    const descriptor = Object.getOwnPropertyDescriptor(ctx, 'input');
    expect(descriptor).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: true,
    });
    expect(() => {
      (ctx as { input: unknown }).input = { a: 2 };
    }).toThrow(TypeError);
    expect(ctx.input).toEqual({ a: 1 });
  });

  it('leaves the context extensible so steps can add their own fields', () => {
    const ctx = createContext({ a: 1 }, engines, noopLogger);
    expect(Object.isExtensible(ctx)).toBe(true);
    Object.assign(ctx, { reservationId: 'r-1' });
    expect((ctx as { reservationId?: string }).reservationId).toBe('r-1');
  });
});
