/**
 * Structured logger injected via `execute(input, { logger })` and exposed at
 * `ctx.logger`. The pipeline logs lifecycle at `debug`, contained hook errors at
 * `warn`, and rollback failures at `error`. Per §1.10 the library never passes
 * `ctx.input` or any context value into `meta` — only names, statuses,
 * durations, and error message/type.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** The default logger: discards everything (§3.7). */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * A small built-in logger that forwards to the matching `console` method. It
 * simply relays what it is given; the log-hygiene guarantee (§1.10) is enforced
 * at the pipeline's call sites, not here.
 */
export const consoleLogger: Logger = {
  debug(msg, meta) {
    if (meta === undefined) console.debug(msg);
    else console.debug(msg, meta);
  },
  info(msg, meta) {
    if (meta === undefined) console.info(msg);
    else console.info(msg, meta);
  },
  warn(msg, meta) {
    if (meta === undefined) console.warn(msg);
    else console.warn(msg, meta);
  },
  error(msg, meta) {
    if (meta === undefined) console.error(msg);
    else console.error(msg, meta);
  },
};
