/**
 * Shared server ports. This dependency-free leaf is also safe for build configuration.
 */

/** The port the live installation's `mimir serve` binds by default. */
export const PROD_PORT = 64647;

/**
 * The default for source and sandbox servers. A separate origin keeps
 * development stores apart from the live console and its cached data.
 */
export const DEV_PORT = 64747;

/**
 * Parse a raw string into a valid TCP port — an integer in 1–65535 — or
 * `null` when it isn't one (non-numeric, non-integer, or out of range).
 * Deliberately silent on `undefined`/absent input: a caller decides what "no
 * value was given" means for it (an unset override vs. a usage fault), then
 * calls this only once it has a string to validate.
 */
export function parsePort(raw: string): number | null {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
