import { UsageError } from './errors';
import { assertSafeName } from './internal';
import type { EngineAccessor, EngineMethods } from './types';

/**
 * A reusable, named bundle of domain functions invoked by steps via
 * `ctx.engines.<name>.<method>`. Engines are callable services, not part
 * of the linear flow. A `Step` calls a method as `ctx.engines.pricing.total(...)`,
 * so the method runs with the bundle as its `this`; pure functions are
 * recommended. The instance is immutable: `name` and `methods` are `readonly`.
 *
 * @param name - Name steps reach the bundle by, as `ctx.engines.<name>`. Must
 * be a non-empty, non-reserved string.
 * @param methods - A non-empty record whose every value is a function.
 * Anything else throws a `UsageError` at construction.
 */
export class Engine {
  readonly name: string;
  readonly methods: EngineMethods;

  // The parameter is the permissive "any record of functions" type so concrete
  // method bundles (e.g. `{ total(order: OrderInput): number }`) construct
  // cast-free; it is stored as the public {@link EngineMethods} (section 3.5). Using
  // `never[]` params keeps it `any`-free while accepting any function arity.
  constructor(
    name: string,
    methods: Record<string, (...args: never[]) => unknown>,
  ) {
    // Empty / non-string / reserved name → UsageError, synchronously (section 1.10).
    assertSafeName('Engine', name);
    // A TS cast could smuggle in a non-object, so re-validate at runtime (section 1.1):
    // the bundle must be a non-empty record whose every value is a function.
    const bundle: unknown = methods;
    if (bundle === null || typeof bundle !== 'object') {
      throw new UsageError(
        `Engine "${name}" expected an object of methods but received a ${typeof bundle}. ` +
          `Pass a record of functions, e.g. new Engine("pricing", { total(order) {} }).`,
      );
    }
    const keys = Object.keys(bundle);
    if (keys.length === 0) {
      throw new UsageError(
        `Engine "${name}" expected at least one method but received an empty object. ` +
          `Add a function, e.g. { total(order) {} }.`,
      );
    }
    const record = bundle as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] !== 'function') {
        throw new UsageError(
          `Engine "${name}" expected method "${key}" to be a function but received ` +
            `a ${typeof record[key]}. Every value in an engine's method bundle must be callable.`,
        );
      }
    }
    this.name = name;
    this.methods = methods as EngineMethods;
  }
}

/**
 * The process-wide engine registry (section 3.5). `Map`-backed, never a plain object
 * keyed by a user-supplied name, so engine names cannot reach the prototype
 * chain (section 1.10). Mutated only via the explicit `registerEngine` / `clearEngines`
 * calls below, keeping the package free of import-time side effects.
 */
const globalRegistry = new Map<string, Engine>();

/**
 * Registers an engine in the global registry. Re-registering an existing name
 * throws a `UsageError` — no silent override. The registry is
 * process-wide shared mutable state; `Pipeline.useEngine` is the isolated,
 * recommended alternative for apps that want no globals.
 *
 * @deprecated Use `pipeline.useEngine(engine)` instead. The global registry
 * is process-wide mutable state: it leaks between tests
 * unless every suite remembers `clearEngines()`, and two pipelines cannot use
 * different engines under the same name. Pipeline-scoped registration has
 * neither problem. Still fully supported; removal is a 1.0 decision.
 */
export function registerEngine(engine: Engine): void {
  if (globalRegistry.has(engine.name)) {
    throw new UsageError(
      `Engine "${engine.name}" is already registered globally, and the registry ` +
        `refuses silent overrides. Use a different name, call clearEngines() first, ` +
        `or scope it to one pipeline with useEngine(engine).`,
    );
  }
  globalRegistry.set(engine.name, engine);
}

/**
 * Empties the global registry. Required for test isolation — suites that call
 * `registerEngine` must invoke this in `afterEach`.
 *
 * @deprecated Deprecated alongside {@link registerEngine}. It exists only to
 * undo global registration; `pipeline.useEngine(engine)` needs no teardown at
 * all. Still fully supported; removal is a 1.0 decision.
 */
export function clearEngines(): void {
  globalRegistry.clear();
}

/**
 * Builds the `ctx.engines` resolver for one `execute` call (section 3.5). It is a
 * `Proxy` over a null-prototype target (section 1.10) so a property access like
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
    get(_target, prop): EngineMethods | undefined {
      // Symbol keys are never engine names. They reach this trap when something
      // probes the object generically — e.g. `console.log(ctx)` triggering
      // Node's `util.inspect.custom` / `Symbol.toStringTag` lookups. Report them
      // absent rather than throwing a confusing "Unknown engine" error; only
      // string names resolve or throw.
      if (typeof prop === 'symbol') {
        return undefined;
      }
      // Resolution order: pipeline-scoped first, then the global registry. The
      // lookups go through `Map.get` and the target is null-prototype, so a name
      // like `constructor` is simply unknown — never a prototype-chain hit.
      const engine = scoped.get(prop) ?? globalRegistry.get(prop);
      if (engine === undefined) {
        throw new UsageError(
          `Unknown engine "${prop}". Register it on the pipeline with ` +
            `useEngine(engine) before a step reads ctx.engines.`,
        );
      }
      return engine.methods;
    },
  });
}
