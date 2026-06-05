import { UsageError } from './errors';

/**
 * Names that must never be used for a step, pipeline, engine, or use-case: they
 * collide with object-prototype keys and are a prototype-pollution vector
 * (§1.10). Held in a `Set` so the membership check never walks the prototype
 * chain.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Validates a user-supplied name, throwing a `UsageError` for a non-string, an
 * empty string, or a reserved/unsafe name. Uses plain string and `Set` checks
 * only — ReDoS-safe, no regex (§1.10). Internal; not part of the public surface.
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
