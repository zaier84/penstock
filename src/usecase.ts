import type { BaseContext } from './context';
import { UsageError } from './errors';
import { assertSafeName } from './internal';
import { Pipeline } from './pipeline';
import type { Result } from './types';

/**
 * Aggregate outcome of a {@link UseCase} run (section 3.6): each executed pipeline's
 * {@link Result} in order, up to and including a failing one. `ok` is `false`
 * once any pipeline returns `ok:false`, and `error` carries that pipeline's
 * failure. Deliberately minimal — the pipeline is the centerpiece.
 */
export interface UseCaseResult {
  ok: boolean;
  pipelines: Result<BaseContext>[];
  error: Error | null;
}

/**
 * A thin, named composition that runs one or more pipelines **sequentially** on
 * the **same input**, short-circuiting on the first failure (section 3.6). Pipelines do
 * not share mutable state — each builds its own fresh context per run (section 3.3), so
 * cross-pipeline data flow is intentionally out of scope for the MVP (section 8). Like
 * `Pipeline`, the instance holds only immutable config; all run state is
 * `execute`-local, so a `UseCase` is safe to run repeatedly and concurrently.
 */
export class UseCase<TInput = unknown> {
  readonly name: string;
  // Build-time config, never per-run state (re-entrancy, section 1.9).
  private readonly pipelines: Pipeline<BaseContext<TInput>>[] = [];

  constructor(name: string) {
    // Empty / non-string / reserved name → UsageError, synchronously (section 1.10).
    assertSafeName('UseCase', name);
    this.name = name;
  }

  /**
   * Appends a pipeline; throws a `UsageError` synchronously if `pipeline` is not
   * a `Pipeline` (section 3.6). The method generic accepts a pipeline over any context
   * that shares this use-case's input type — which a plain parameter type cannot,
   * since `Pipeline` is effectively invariant in its context — and the stored
   * array is widened through a single bridge cast. Chainable.
   */
  addPipeline<TContext extends BaseContext<TInput>>(
    pipeline: Pipeline<TContext>,
  ): this {
    if (!(pipeline instanceof Pipeline)) {
      throw new UsageError('UseCase.addPipeline expects a Pipeline instance');
    }
    this.pipelines.push(pipeline as unknown as Pipeline<BaseContext<TInput>>);
    return this;
  }

  /**
   * Runs each pipeline in order on the same `input`, collecting their Results.
   * Stops at the first pipeline returning `ok:false` and surfaces its error;
   * otherwise resolves `ok:true` with every Result (section 3.6). Each pipeline.execute
   * builds its own isolated context (section 3.3).
   */
  async execute(input: TInput): Promise<UseCaseResult> {
    const pipelines: Result<BaseContext>[] = [];
    for (const pipeline of this.pipelines) {
      const result = await pipeline.execute(input);
      pipelines.push(result);
      if (!result.ok) {
        return { ok: false, pipelines, error: result.error };
      }
    }
    return { ok: true, pipelines, error: null };
  }
}
