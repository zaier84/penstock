import { UsageError } from './errors';
import { assertSafeName } from './internal';
import type { EngineAccessor, EngineMethods } from './types';

/**
 * A reusable, named bundle of domain functions invoked by steps via
 * `ctx.engines.<name>.<method>` (§3.5). Engines are callable services, not part
 * of the linear flow. A `Step` calls a method as `ctx.engines.pricing.total(...)`,
 * so the method runs with the bundle as its `this`; pure functions are
 * recommended. The instance is immutable: `name` and `methods` are `readonly`.
 */
export class Engine {
  readonly name: string;
  readonly methods: EngineMethods;

  // The parameter is the permissive "any record of functions" type so concrete
  // method bundles (e.g. `{ total(order: OrderInput): number }`) construct
  // cast-free; it is stored as the public {@link EngineMethods} (§3.5). Using
  // `never[]` params keeps it `any`-free while accepting any function arity.
  constructor(
    name: string,
    methods: Record<string, (...args: never[]) => unknown>,
  ) {
    // Empty / non-string / reserved name → UsageError, synchronously (§1.10).
    assertSafeName('Engine', name);
    // A TS cast could smuggle in a non-object, so re-validate at runtime (§1.1):
    // the bundle must be a non-empty record whose every value is a function.
    const bundle: unknown = methods;
    if (bundle === null || typeof bundle !== 'object') {
      throw new UsageError(
        `Engine "${name}" requires a non-empty object of methods`,
      );
    }
    const keys = Object.keys(bundle);
    if (keys.length === 0) {
      throw new UsageError(
        `Engine "${name}" requires a non-empty object of methods`,
      );
    }
    const record = bundle as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] !== 'function') {
        throw new UsageError(
          `Engine "${name}" method "${key}" must be a function`,
        );
      }
    }
    this.name = name;
    this.methods = methods as EngineMethods;
  }
}

/**
 * The process-wide engine registry (§3.5). `Map`-backed, never a plain object
 * keyed by a user-supplied name, so engine names cannot reach the prototype
 * chain (§1.10). Mutated only via the explicit `registerEngine` / `clearEngines`
 * calls below, keeping the package free of import-time side effects.
 */
const globalRegistry = new Map<string, Engine>();

/**
 * Registers an engine in the global registry. Re-registering an existing name
 * throws a `UsageError` — no silent override (§3.5). The registry is
 * process-wide shared mutable state; `Pipeline.useEngine` is the isolated,
 * recommended alternative for apps that want no globals.
 */
export function registerEngine(engine: Engine): void {
  if (globalRegistry.has(engine.name)) {
    throw new UsageError(`Engine "${engine.name}" is already registered`);
  }
  globalRegistry.set(engine.name, engine);
}

/**
 * Empties the global registry. Required for test isolation — suites that call
 * `registerEngine` must invoke this in `afterEach` (§3.5).
 */
export function clearEngines(): void {
  globalRegistry.clear();
}

/**
 * Builds the `ctx.engines` resolver for one `execute` call (§3.5). It is a
 * `Proxy` over a null-prototype target (§1.10) so a property access like
 * `ctx.engines.pricing` resolves by name: pipeline-scoped engines shadow global
 * ones, and an unregistered name throws a clear `UsageError` (`Unknown engine
 * "x"`) rather than yielding `undefined` and a downstream `TypeError`. Lookups
 * go through `Map.get`, so a name never walks an object prototype chain.
 */
export function createEngineAccessor(
  scoped: ReadonlyMap<string, Engine>,
): EngineAccessor {
  const target = Object.create(null) as EngineAccessor;
  return new Proxy(target, {
    get(_target, prop): EngineMethods {
      // `String(prop)` also coerces any symbol key to a string for the lookup,
      // which a `Map` simply reports as absent — never a prototype-chain hit.
      const name = String(prop);
      // Resolution order: pipeline-scoped first, then the global registry.
      const engine = scoped.get(name) ?? globalRegistry.get(name);
      if (engine === undefined) {
        throw new UsageError(`Unknown engine "${name}"`);
      }
      return engine.methods;
    },
  });
}
