/**
 * The `mimir serve` port facts. A leaf with no imports, so the console's Vite
 * config can import it by path: its config loader leaves workspace packages to
 * Node, which cannot resolve the package barrel.
 */

/** The port the live installation's `mimir serve` binds by default. */
export const PROD_PORT = 64647;

/**
 * The port any other `mimir serve` binds by default — a from-source or sandbox
 * run. The dev console's Vite proxy forwards `/api` here (MMR-426).
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
