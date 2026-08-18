// The typed builder's public surface (0.5.0 spec, section 6). Pure re-exports;
// `mergeContribution` stays internal to ./merge, reached by ./define's wrapper.

export { pipeline } from './builder';
export { defineStep } from './define';
export type { ProducesOf, RequiresOf, StepDef } from './define';
export type {
  ComposeContribution,
  InnerCtxOf,
  InnerInputOf,
  Merge,
  Simplify,
  StateOf,
  StepReturn,
  TypedComposeOptions,
  TypedCtx,
  TypedPipeline,
  UnionToIntersection,
} from './types';
