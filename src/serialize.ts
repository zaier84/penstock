import type { BaseContext } from './context';
import { PipelineError } from './errors';
import type {
  Result,
  SerializeOptions,
  SerializedError,
  SerializedResult,
  SerializedStepReport,
  StepReport,
} from './types';

/** Stands in for a value already on the current serialization path. */
const CIRCULAR = '[Circular]';
/**
 * Stands in for a value JSON cannot hold (`bigint`, `symbol`, functions) or
 * one that could not be read at all (a throwing getter or `toJSON`).
 */
const UNSERIALIZABLE = '[Unserializable]';

/** Error keys rendered explicitly; never re-copied by the custom-property pass. */
const BASE_ERROR_KEYS = new Set(['name', 'message', 'stack', 'cause']);

/** Resolved options plus the current recursion path, threaded through the walk. */
interface Walker {
  readonly includeContext: boolean;
  readonly includeStacks: boolean;
  readonly maxCauseDepth: number;
  /**
   * The objects on the **current path**, added on entry and removed on exit.
   * Only an ancestor repeat is a cycle: a merely *shared* reference — such as
   * the one `StepError` penstock stores on both `result.error` and the failing
   * step's report — is serialized in full at each occurrence.
   */
  readonly path: WeakSet<object>;
}

/**
 * Flattens a {@link Result} into a plain object that survives
 * `JSON.stringify` (0.4.0 spec, section 1.6): live `Error` instances become
 * `{ name, message, stack?, cause? }` plus their custom fields, circular
 * references become `'[Circular]'`, and values JSON cannot hold become
 * `'[Unserializable]'`.
 *
 * It is a **standalone function, not `Result.toJSON()`**: attaching a method
 * would make `Result` non-plain, which risks breaking users' deep-equality
 * assertions and structured-clone usage. It is pure — no I/O, no telemetry
 * (section 1.10) — and never mutates the `Result` it is given.
 *
 * **`context` is excluded by default.** That is the same security decision as
 * the log-hygiene invariant (section 1.10): a serialized `Result` is destined
 * for a log aggregator, and contexts routinely hold PII, tokens, and payment
 * details. `{ includeContext: true }` opts in, best-effort and with the same
 * circular guard.
 */
export function serializeResult<TContext extends BaseContext>(
  result: Result<TContext>,
  options: SerializeOptions = {},
): SerializedResult {
  return serializeResultWith(result, {
    includeContext: options.includeContext ?? false,
    includeStacks: options.includeStacks ?? true,
    maxCauseDepth: options.maxCauseDepth ?? 5,
    path: new WeakSet<object>(),
  });
}

/** Renders one `Result`, keeping the key order documented in section 1.6. */
function serializeResultWith(
  result: Result<BaseContext>,
  walker: Walker,
): SerializedResult {
  walker.path.add(result);
  try {
    const out: SerializedResult = {
      ok: result.ok,
      aborted: result.aborted,
      executionId: result.executionId,
      pipelineName: result.pipelineName,
      durationMs: result.durationMs,
      error:
        result.error === null ? null : serializeError(result.error, 0, walker),
      rollbackErrors: result.rollbackErrors.map((error) =>
        serializeError(error, 0, walker),
      ),
      steps: result.steps.map((step) => serializeStepReport(step, walker)),
    };
    if (walker.includeContext) {
      out.context = serializeValue(result.context, 0, walker);
    }
    return out;
  } finally {
    walker.path.delete(result);
  }
}

/**
 * Renders one {@link StepReport}, carrying only the optional fields that are
 * actually present so the output stays as sparse as the report. A nested
 * pipeline's `innerResult` (0.3.0 spec, section 1.2.5) is serialized
 * recursively **under the same options**; a self-referential one is dropped
 * rather than recursed into.
 */
function serializeStepReport(
  report: StepReport,
  walker: Walker,
): SerializedStepReport {
  const out: SerializedStepReport = {
    name: report.name,
    status: report.status,
    durationMs: report.durationMs,
  };
  if (report.error !== undefined) {
    out.error = serializeError(report.error, 0, walker);
  }
  if (report.skipReason !== undefined) {
    out.skipReason = report.skipReason;
  }
  if (report.attempts !== undefined) {
    out.attempts = report.attempts;
  }
  if (report.timedOut !== undefined) {
    out.timedOut = report.timedOut;
  }
  if (report.idempotencyKey !== undefined) {
    out.idempotencyKey = report.idempotencyKey;
  }
  if (
    report.innerResult !== undefined &&
    !walker.path.has(report.innerResult)
  ) {
    out.innerResult = serializeResultWith(report.innerResult, walker);
  }
  return out;
}

/**
 * Renders any thrown value as a {@link SerializedError}. Never throws:
 * a non-`Error` becomes `UnknownError`, an unreadable property becomes
 * `'[Unserializable]'`, and a value already on the path is marked circular.
 *
 * `depth` counts `cause` links followed so far; a `cause` is followed only
 * while `depth < maxCauseDepth`, and truncation is simply the absence of the
 * key — no placeholder node.
 */
function serializeError(
  value: unknown,
  depth: number,
  walker: Walker,
): SerializedError {
  if (!(value instanceof Error)) {
    return { name: 'UnknownError', message: safeString(value) };
  }
  const name = safeString(readProperty(value, 'name'));
  if (walker.path.has(value)) {
    return { name, message: CIRCULAR };
  }
  walker.path.add(value);
  try {
    const out: SerializedError = {
      name,
      message: safeString(readProperty(value, 'message')),
    };
    const stack = readProperty(value, 'stack');
    if (walker.includeStacks && typeof stack === 'string') {
      out.stack = stack;
    }
    // `cause` is an own **non-enumerable** property, so it is followed here
    // rather than by the custom-property pass below. It is present-but-
    // undefined when a step threw `undefined`, which still renders as an
    // UnknownError; testing for the property, not the value, keeps that.
    if (depth < walker.maxCauseDepth && Object.hasOwn(value, 'cause')) {
      out.cause = serializeError(
        readProperty(value, 'cause'),
        depth + 1,
        walker,
      );
    }
    // Likewise own-non-enumerable, and required to be an array (section 1.6).
    if (value instanceof AggregateError) {
      const errors = readProperty(value, 'errors');
      out.errors = Array.isArray(errors)
        ? errors.map((entry) => serializeError(entry, depth + 1, walker))
        : [];
    }
    // A PipelineError's Result is rendered as a nested SerializedResult under
    // the same options, so its context stays excluded unless opted into — a
    // generic walk would leak `ctx.input` past the context rule above.
    if (value instanceof PipelineError) {
      out.result = walker.path.has(value.result)
        ? CIRCULAR
        : serializeResultWith(value.result, walker);
    }
    // Everything else the error carries: StepError.stepName, a user's own
    // fields. Keys already rendered above are skipped, never overwritten.
    for (const key of safeKeys(value)) {
      if (BASE_ERROR_KEYS.has(key) || Object.hasOwn(out, key)) {
        continue;
      }
      define(out, key, serializeValue(readProperty(value, key), depth, walker));
    }
    return out;
  } finally {
    walker.path.delete(value);
  }
}

/**
 * Renders an arbitrary value — a custom error property, or the context under
 * `includeContext` — as something `JSON.stringify` accepts. Mirrors what
 * `JSON.stringify` itself does (including honouring `toJSON`, so a `Date`
 * keeps its ISO form) but degrades instead of throwing.
 */
function serializeValue(
  value: unknown,
  depth: number,
  walker: Walker,
): unknown {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'undefined'
  ) {
    // NaN and Infinity become null under JSON.stringify, which does not throw.
    return value;
  }
  if (type === 'bigint' || type === 'symbol' || type === 'function') {
    return UNSERIALIZABLE;
  }
  const object = value as object;
  if (walker.path.has(object)) {
    return CIRCULAR;
  }
  if (value instanceof Error) {
    return serializeError(value, depth + 1, walker);
  }
  walker.path.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => serializeValue(entry, depth, walker));
    }
    const rendered = callToJSON(object);
    if (rendered.handled) {
      return serializeValue(rendered.value, depth, walker);
    }
    const out: Record<string, unknown> = {};
    for (const key of safeKeys(object)) {
      define(
        out,
        key,
        serializeValue(readProperty(object, key), depth, walker),
      );
    }
    return out;
  } finally {
    walker.path.delete(object);
  }
}

/**
 * Applies a value's own `toJSON`, the way `JSON.stringify` would. Both the
 * property read and the call are guarded: `ctx.engines` is a `Proxy` that
 * throws on every unknown property (section 3.5), so merely *probing* for
 * `toJSON` can throw.
 */
function callToJSON(value: object): { handled: boolean; value: unknown } {
  let toJSON: unknown;
  try {
    toJSON = (value as { toJSON?: unknown }).toJSON;
  } catch {
    return { handled: false, value: undefined };
  }
  if (typeof toJSON !== 'function') {
    return { handled: false, value: undefined };
  }
  try {
    return { handled: true, value: (toJSON as () => unknown).call(value) };
  } catch {
    return { handled: true, value: UNSERIALIZABLE };
  }
}

/** Reads a property, degrading a throwing getter into a marker. */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
}

/** Lists own enumerable string keys, degrading a throwing `ownKeys` trap. */
function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

/** Coerces to a string, degrading values that throw on coercion. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Writes a **user-controlled** key onto an output object. `defineProperty`,
 * never assignment: a property literally named `__proto__` must become an own
 * data property, not reassign the prototype (section 1.10).
 */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
