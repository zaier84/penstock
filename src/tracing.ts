import { describeError } from './internal';
import type { Logger } from './logger';
import type { Result, StepReport, TraceSpan, Tracer } from './types';
import type { BaseContext } from './context';

/**
 * Every attribute key penstock emits, in one place (0.4.0 spec, section 1.8).
 * All are namespaced `penstock.*`, and every value is a name, an id, a status,
 * a count, a duration, or the idempotency key — the security invariant of
 * section 1.8 is that no context or input value may ever reach a span, so this
 * table is the whole surface a reviewer has to audit.
 */
const ATTR = {
  pipelineName: 'penstock.pipeline.name',
  executionId: 'penstock.execution.id',
  stepCount: 'penstock.pipeline.step_count',
  pipelineOk: 'penstock.pipeline.ok',
  pipelineAborted: 'penstock.pipeline.aborted',
  pipelineDurationMs: 'penstock.pipeline.duration_ms',
  rollbackErrorCount: 'penstock.pipeline.rollback_error_count',
  stepName: 'penstock.step.name',
  idempotencyKey: 'penstock.step.idempotency_key',
  stepStatus: 'penstock.step.status',
  stepAttempts: 'penstock.step.attempts',
  stepDurationMs: 'penstock.step.duration_ms',
  stepTimedOut: 'penstock.step.timed_out',
  stepSkipReason: 'penstock.step.skip_reason',
} as const;

/**
 * A started span whose every user-tracer call is contained (0.4.0 spec,
 * section 1.8) with the same discipline as hooks (`BUILD_SPEC.md` section
 * 1.8): a throw is caught, logged at `warn` with the error's type and message
 * only, and never alters the run. A broken tracer must not fail a pipeline.
 */
export interface SafeSpan {
  /**
   * The user's own span object, or `undefined` when `startSpan` threw. Needed
   * only to parent a child span, which is the tracer's own vocabulary — the
   * rest of the library never touches it.
   */
  readonly raw: TraceSpan | undefined;
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: unknown): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}

/**
 * The span factory for one execution. It owns every span *name*, so the naming
 * scheme of section 1.8 lives in exactly one file, and it decides which spans
 * exist at all — notably that attempt spans appear only for a retrying step.
 */
export interface Tracing {
  /** `penstock.pipeline ${name}`, the root span of a run. */
  pipeline(pipelineName: string, parent: TraceSpan | undefined): SafeSpan;
  /** `penstock.step ${name}`, a child of the pipeline span. */
  step(stepName: string, parent: SafeSpan): SafeSpan;
  /**
   * `penstock.attempt ${name}#${n}`, a child of the step span — emitted
   * **only when `maxAttempts > 1`**, i.e. when the step actually retries
   * (section 1.8). A single-attempt step would otherwise get a span that
   * duplicates its step span exactly.
   */
  attempt(
    stepName: string,
    attempt: number,
    maxAttempts: number,
    parent: SafeSpan,
  ): SafeSpan;
  /** `penstock.undo ${name}`, a child of the pipeline span. */
  undo(stepName: string, parent: SafeSpan): SafeSpan;
}

/** The span used whenever no tracer is configured: allocation-free and inert. */
const NOOP_SPAN: SafeSpan = {
  raw: undefined,
  setAttribute() {},
  recordException() {},
  setStatus() {},
  end() {},
};

/**
 * The factory used when `execute` was given no tracer, and during dry-run —
 * which emits no spans at all (section 1.8). It returns the shared inert span
 * without even building a span name, so an untraced run pays nothing.
 */
const NOOP_TRACING: Tracing = {
  pipeline: () => NOOP_SPAN,
  step: () => NOOP_SPAN,
  attempt: () => NOOP_SPAN,
  undo: () => NOOP_SPAN,
};

/** Wraps one user span so no call it makes can escape (section 1.8). */
class ContainedSpan implements SafeSpan {
  readonly raw: TraceSpan | undefined;
  private readonly logger: Logger;

  constructor(raw: TraceSpan | undefined, logger: Logger) {
    this.raw = raw;
    this.logger = logger;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.contain('setAttribute', (span) => {
      span.setAttribute(key, value);
    });
  }

  recordException(error: unknown): void {
    this.contain('recordException', (span) => {
      span.recordException(error);
    });
  }

  setStatus(status: 'ok' | 'error', message?: string): void {
    this.contain('setStatus', (span) => {
      span.setStatus(status, message);
    });
  }

  end(): void {
    this.contain('end', (span) => {
      span.end();
    });
  }

  /**
   * Runs one span call, swallowing any throw. Tracer calls are synchronous by
   * contract, so unlike hooks there is nothing to await — a tracer that
   * returns a rejected promise is simply ignored, exactly as an observer
   * should be.
   */
  private contain(call: string, invoke: (span: TraceSpan) => void): void {
    if (this.raw === undefined) {
      return;
    }
    try {
      invoke(this.raw);
    } catch (err) {
      this.logger.warn('tracer threw', { call, ...describeError(err) });
    }
  }
}

/**
 * Builds the span factory for one execution. `undefined` — no tracer supplied
 * — yields the inert factory, so the executor stays branch-free: it always has
 * a `Tracing` and a `SafeSpan` to talk to.
 */
export function createTracing(
  tracer: Tracer | undefined,
  logger: Logger,
): Tracing {
  if (tracer === undefined) {
    return NOOP_TRACING;
  }
  const start = (name: string, parent: TraceSpan | undefined): SafeSpan => {
    try {
      // `parent` is omitted rather than passed as undefined so a tracer can
      // distinguish "no parent" by arity if it wants to.
      return new ContainedSpan(
        parent === undefined
          ? tracer.startSpan(name)
          : tracer.startSpan(name, parent),
        logger,
      );
    } catch (err) {
      logger.warn('tracer threw', {
        call: 'startSpan',
        ...describeError(err),
      });
      // A span that never started still has to answer every call, so the run
      // downstream needs no idea that tracing failed.
      return new ContainedSpan(undefined, logger);
    }
  };
  return {
    pipeline: (pipelineName, parent) =>
      start(`penstock.pipeline ${pipelineName}`, parent),
    step: (stepName, parent) => start(`penstock.step ${stepName}`, parent.raw),
    attempt: (stepName, attempt, maxAttempts, parent) =>
      maxAttempts > 1
        ? start(`penstock.attempt ${stepName}#${attempt}`, parent.raw)
        : NOOP_SPAN,
    undo: (stepName, parent) => start(`penstock.undo ${stepName}`, parent.raw),
  };
}

/** Stamps the attributes a pipeline span carries from the moment it starts. */
export function recordPipelineStart(
  span: SafeSpan,
  pipelineName: string,
  executionId: string,
  stepCount: number,
): void {
  span.setAttribute(ATTR.pipelineName, pipelineName);
  span.setAttribute(ATTR.executionId, executionId);
  span.setAttribute(ATTR.stepCount, stepCount);
}

/**
 * Stamps the attributes and terminal status a pipeline span carries once the
 * run has settled. A cancelled run is `ok: false` like a failed one; the
 * `aborted` attribute is what tells them apart.
 */
export function recordPipelineOutcome(
  span: SafeSpan,
  result: Result<BaseContext>,
): void {
  span.setAttribute(ATTR.pipelineOk, result.ok);
  span.setAttribute(ATTR.pipelineAborted, result.aborted);
  span.setAttribute(ATTR.pipelineDurationMs, result.durationMs);
  span.setAttribute(ATTR.rollbackErrorCount, result.rollbackErrors.length);
  if (result.ok) {
    span.setStatus('ok');
    return;
  }
  if (result.error !== null) {
    span.recordException(result.error);
  }
  span.setStatus('error', result.error?.message);
}

/** Stamps a step span's name, the one attribute known before anything runs. */
export function recordStepStart(span: SafeSpan, stepName: string): void {
  span.setAttribute(ATTR.stepName, stepName);
}

/**
 * Stamps the idempotency key, which is resolved after the guard but before the
 * first attempt (section 1.4). It is the one user-influenced value that may
 * appear in a trace, by design: it exists for cross-system correlation, and the
 * README notes that a key derived from sensitive data will be visible here.
 */
export function recordStepKey(span: SafeSpan, idempotencyKey: string): void {
  span.setAttribute(ATTR.idempotencyKey, idempotencyKey);
}

/**
 * The facts a settled step contributes to its span — exactly the subset of
 * {@link StepReport} that section 1.8 permits. Taking a structural subset lets
 * a real report be passed straight through while a parallel step, whose report
 * is not assembled until its group has fully settled, passes the equivalent
 * facts at the moment its own span must close.
 */
export type StepSpanOutcome = Pick<
  StepReport,
  'status' | 'durationMs' | 'attempts' | 'timedOut' | 'skipReason' | 'error'
>;

/** Stamps the completion attributes and terminal status of a step span. */
export function recordStepOutcome(
  span: SafeSpan,
  outcome: StepSpanOutcome,
): void {
  span.setAttribute(ATTR.stepStatus, outcome.status);
  span.setAttribute(ATTR.stepDurationMs, outcome.durationMs);
  if (outcome.attempts !== undefined) {
    span.setAttribute(ATTR.stepAttempts, outcome.attempts);
  }
  // Both are "when applicable" attributes (section 1.8), so a step that
  // neither timed out nor was skipped carries neither key.
  if (outcome.timedOut) {
    span.setAttribute(ATTR.stepTimedOut, true);
  }
  if (outcome.skipReason !== undefined) {
    span.setAttribute(ATTR.stepSkipReason, outcome.skipReason);
  }
  if (outcome.status === 'failed') {
    if (outcome.error !== undefined) {
      span.recordException(outcome.error);
    }
    span.setStatus('error', outcome.error?.message);
    return;
  }
  // Completed and skipped steps alike are a successful observation.
  span.setStatus('ok');
}

/** Stamps a compensation span's name before the `undo` runs. */
export function recordUndoStart(span: SafeSpan, stepName: string): void {
  span.setAttribute(ATTR.stepName, stepName);
}

/**
 * Stamps a compensation span's outcome: the step's new status
 * (`'rolled-back'` or `'rollback-failed'`) and, when the `undo` threw, the
 * error — compensation failures are the single most important thing a trace
 * can surface, since the pipeline deliberately does not stop for them.
 */
export function recordUndoOutcome(
  span: SafeSpan,
  status: StepReport['status'],
  error?: Error,
): void {
  span.setAttribute(ATTR.stepStatus, status);
  if (error !== undefined) {
    span.recordException(error);
    span.setStatus('error', error.message);
    return;
  }
  span.setStatus('ok');
}

/**
 * Stamps one attempt span. Attempt spans carry no attributes — the span name
 * already names the step and the attempt number, and section 1.8 lists no
 * attributes for them — only the outcome of that single `run` invocation.
 */
export function recordAttemptOutcome(
  span: SafeSpan,
  outcome: { ok: boolean; error?: unknown },
): void {
  if (outcome.ok) {
    span.setStatus('ok');
    return;
  }
  span.recordException(outcome.error);
  // Deliberately not `String(error)`: a thrown value may refuse coercion, and
  // a tracer call must never be the thing that breaks a run.
  span.setStatus(
    'error',
    outcome.error instanceof Error ? outcome.error.message : undefined,
  );
}
