import { UsageError } from '../errors';
import { RESERVED_NAMES } from '../internal';

/**
 * Context fields penstock owns (`BUILD_SPEC.md` section 3.3, 0.4.0 spec
 * sections 1.1 and 1.3). A contribution may not name any of them: `input` is
 * pinned non-writable and the other four are the run's own machinery, so a step
 * that returned one of these keys is a bug worth surfacing rather than a write
 * worth attempting.
 */
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'input',
  'engines',
  'logger',
  'signal',
  'executionId',
]);

/**
 * Merges a typed step's returned contribution onto the run context (0.5.0
 * spec, section 3.1). This is the **only** path by which a value a user's `run`
 * returned becomes a context key, so it is the one place the guards have to
 * live — `compose` funnels its `mapResult` output through here too, rather than
 * duplicating them.
 *
 * Returning nothing (`undefined` or `null`) merges nothing. Anything that is
 * not a plain object — an array, a function, a primitive, a `Date`, a class
 * instance — throws a `UsageError`. Silently ignoring those would hide real
 * bugs in untyped JavaScript callers, where the compiler is not there to catch
 * them. The throw happens inside `run`, so it surfaces as an ordinary step
 * failure and triggers rollback like any other.
 *
 * Merging is **all-or-nothing**: every key is validated before any is written,
 * so a contribution carrying one hostile key never lands its innocent ones.
 */
export function mergeContribution(
  ctx: object,
  contribution: unknown,
  stepName: string,
): void {
  if (contribution === undefined || contribution === null) {
    return;
  }
  if (!isPlainObject(contribution)) {
    throw new UsageError(
      `Step "${stepName}" returned ${describeReturn(contribution)}. A step must ` +
        `return a plain object to merge into the context, or nothing. Return an ` +
        `object literal, e.g. { reservationId }, or drop the return.`,
    );
  }

  const keys = Object.keys(contribution);
  for (const key of keys) {
    // Prototype-pollution guard (section 1.10). A contribution is user data
    // reaching a computed write, which is exactly the shape the invariant
    // exists for — and the reason the write below is defineProperty.
    if (RESERVED_NAMES.has(key)) {
      throw new UsageError(
        `Step "${stepName}" returned a contribution with the reserved key ` +
          `"${key}". The keys __proto__, prototype and constructor are refused ` +
          `because they can pollute the prototype chain. Rename the field.`,
      );
    }
    if (RESERVED_CONTEXT_KEYS.has(key)) {
      throw new UsageError(
        `Step "${stepName}" returned a contribution with the key "${key}", ` +
          `which is a context field penstock owns. Rename the field; input, ` +
          `engines, logger, signal and executionId are reserved.`,
      );
    }
  }

  for (const key of keys) {
    define(ctx, key, contribution[key]);
  }
}

/**
 * Whether a value is a plain object, i.e. one whose prototype is
 * `Object.prototype` or `null` (0.5.0 spec, section 3.1). Arrays, functions,
 * `Date`s, `Map`s, and class instances all fail this and are refused: a step
 * returning one of them meant to return data, not a live object to splice into
 * the shared context.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Names the *shape* of a rejected return for the error message — never its
 * contents. Error messages carry names and types, never raw payloads
 * (section 1.10).
 */
function describeReturn(value: unknown): string {
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'function') {
    return 'a function';
  }
  if (typeof value === 'object') {
    return 'a non-plain object';
  }
  return `a ${typeof value}`;
}

/**
 * Writes one contribution key onto the context. `defineProperty`, never
 * assignment: assignment consults the prototype chain for a setter, and the
 * whole point of this module is that the key came from user data
 * (section 1.10). Reserved keys are already refused above; this is the second
 * line of the same defence, and it mirrors the serializer's own writer.
 */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
