import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import {
  PenstockError,
  PipelineError,
  StepError,
  UsageError,
} from '../src/errors';
import type { Result } from '../src/types';

describe('errors', () => {
  describe('PenstockError', () => {
    it('is an Error subclass with the right name and message', () => {
      const err = new PenstockError('boom');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PenstockError);
      expect(err.name).toBe('PenstockError');
      expect(err.message).toBe('boom');
    });

    it('forwards the native cause option', () => {
      const cause = new Error('root');
      const err = new PenstockError('boom', { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe('UsageError', () => {
    it('extends PenstockError and Error with instanceof intact', () => {
      const err = new UsageError('bad name');
      expect(err).toBeInstanceOf(UsageError);
      expect(err).toBeInstanceOf(PenstockError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('UsageError');
    });

    it('preserves cause', () => {
      const cause = new Error('root');
      const err = new UsageError('bad', { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe('StepError', () => {
    it('carries the step name and a name-only message', () => {
      const err = new StepError('reserve-inventory');
      expect(err).toBeInstanceOf(StepError);
      expect(err).toBeInstanceOf(PenstockError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('StepError');
      expect(err.stepName).toBe('reserve-inventory');
      expect(err.message).toBe('Step "reserve-inventory" failed');
    });

    it('preserves the original error as cause', () => {
      const cause = new Error('no items');
      const err = new StepError('validate-order', { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe('PipelineError', () => {
    const makeResult = (error: Error): Result<BaseContext> => ({
      ok: false,
      context: {} as BaseContext,
      steps: [],
      error,
      rollbackErrors: [],
    });

    it('carries the result and originating cause; no rollbackErrors by default', () => {
      const cause = new Error('step failed');
      const result = makeResult(cause);
      const err = new PipelineError('pipeline failed', { result, cause });
      expect(err).toBeInstanceOf(PipelineError);
      expect(err).toBeInstanceOf(PenstockError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PipelineError');
      expect(err.result).toBe(result);
      expect(err.cause).toBe(cause);
      expect(err.rollbackErrors).toBeUndefined();
    });

    it('bundles undo failures as an AggregateError when provided', () => {
      const cause = new Error('step failed');
      const rollbackErrors = new AggregateError(
        [new Error('undo a'), new Error('undo b')],
        'rollback failed',
      );
      const err = new PipelineError('pipeline failed', {
        result: makeResult(cause),
        cause,
        rollbackErrors,
      });
      expect(err.rollbackErrors).toBe(rollbackErrors);
      expect(err.rollbackErrors?.errors).toHaveLength(2);
    });
  });
});
