/**
 * The single clock. Every timestamp the core writes is ISO-8601, UTC,
 * millisecond precision, explicit `Z` — exactly what `Date#toISOString`
 * produces and what the schema's columns expect. `created_at` is left to the
 * DB default; the core stamps `updated_at` (and friends) through here.
 */
export function now(): string {
  return new Date().toISOString();
}
