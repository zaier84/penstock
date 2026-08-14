// Public API surface for penstock — the complete set of exports (section 3).

export { Step } from './step';
export { Pipeline } from './pipeline';
export type { ExecuteOptions } from './pipeline';
export { Engine, registerEngine, clearEngines } from './engine';
export { UseCase } from './usecase';
export type { UseCaseResult } from './usecase';
export { noopLogger, consoleLogger } from './logger';
export type { Logger } from './logger';
export { PenstockError, PipelineError, StepError, UsageError } from './errors';
export type { BaseContext } from './context';
export type {
  AfterHook,
  AsStepOptions,
  BeforeHook,
  EngineAccessor,
  EngineMethods,
  ErrorHook,
  GuardFn,
  LifecycleCallback,
  Result,
  RetryOptions,
  RunFn,
  StepMeta,
  StepOptions,
  StepReport,
  StepStatus,
  UndoFn,
} from './types';
