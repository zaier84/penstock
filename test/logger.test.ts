import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleLogger, noopLogger } from '../src/logger';

describe('noopLogger', () => {
  it('exposes the four log levels and returns undefined from each', () => {
    expect(noopLogger.debug('a')).toBeUndefined();
    expect(noopLogger.info('b')).toBeUndefined();
    expect(noopLogger.warn('c')).toBeUndefined();
    expect(noopLogger.error('d', { k: 1 })).toBeUndefined();
  });
});

describe('consoleLogger', () => {
  const levels = ['debug', 'info', 'warn', 'error'] as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the message only when no meta is given', () => {
    for (const level of levels) {
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      consoleLogger[level]('hello');
      expect(spy).toHaveBeenCalledWith('hello');
    }
  });

  it('forwards the message and meta when meta is given', () => {
    for (const level of levels) {
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      const meta = { stepName: 's', durationMs: 3 };
      consoleLogger[level]('hello', meta);
      expect(spy).toHaveBeenCalledWith('hello', meta);
    }
  });
});
