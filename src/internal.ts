import { UsageError } from './errors';

/**
 * Names that must never be used for a step, pipeline, engine, or use-case: they
 * collide with object-prototype keys and are a prototype-pollution vector
 * (section 1.10). Held in a `Set` so the membership check never walks the prototype
 * chain. Exported so a single set backs every guard, including the typed
 * builder contribution-key check (0.5.0 spec, section 3.1).
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Validates a user-supplied name, throwing a `UsageError` for a non-string, an
 * empty string, or a reserved/unsafe name. Uses plain string and `Set` checks
 * only — ReDoS-safe, no regex (section 1.10). Internal; not part of the public surface.
 *
 * @param kind Human label for the entity, used in the error message (e.g. "Step").
 * @param name The candidate name to validate.
 */
export function assertSafeName(
  kind: string,
  name: unknown,
): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError(`${kind} name must be a non-empty string`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new UsageError(`${kind} name "${name}" is reserved and not allowed`);
  }
}

/**
 * Stands in for a thrown value that refuses string coercion — a null-prototype
 * object, or one whose `Symbol.toPrimitive` throws.
 */
const UNCOERCIBLE = '[uncoercible value]';

/**
 * Reduces a thrown value to a loggable `{ errorType, errorMessage }` — names and
 * types only, never raw payloads or context (section 1.10). Handles non-Error throws.
 * Shared by every contained-callback log site: hooks, lifecycle callbacks, and
 * tracer calls (0.4.0 spec, section 1.8).
 *
 * The coercion is guarded because `String(value)` is not total: a step is free
 * to `throw Object.create(null)`, which has no `toString`, and coercing it
 * throws a `TypeError`. Since this function is on the step-failure logging
 * path, letting that escape would make `execute()` **reject** rather than
 * resolve `ok: false`, breaking the failure model that says operational
 * failures come back as data (section 1.1).
 */
export function describeError(err: unknown): {
  errorType: string;
  errorMessage: string;
} {
  return err instanceof Error
    ? { errorType: err.name, errorMessage: err.message }
    : { errorType: typeof err, errorMessage: coerce(err) };
}

/** `String(value)`, degrading a value that refuses coercion to a fixed label. */
function coerce(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNCOERCIBLE;
  }
}
