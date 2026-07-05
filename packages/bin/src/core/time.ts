/**
 * The single clock. Every timestamp the core writes is ISO-8601, UTC,
 * millisecond precision, explicit `Z` — exactly what `Date#toISOString`
 * produces and what the schema's columns expect. The core is the sole
 * time-maintainer: `updated_at`, `completed_at`, and — since MMR-173 — a
 * transition's `at` and an annotation's `created_at` are all stamped through
 * here, so no per-backend DB default decides the time. The matching column
 * defaults survive only as a backstop for a direct-SQL write outside the core.
 */
export function now(): string {
  return new Date().toISOString();
}
