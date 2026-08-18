// The typed builder's public surface (0.5.0 spec, section 6). Pure re-exports;
// `mergeContribution` stays internal to ./merge, reached directly by the
// builder and, from Phase B, by `compose`.

export { pipeline } from './builder';
export type {
  Merge,
  Simplify,
  StateOf,
  StepReturn,
  TypedCtx,
  TypedPipeline,
  UnionToIntersection,
} from './types';
