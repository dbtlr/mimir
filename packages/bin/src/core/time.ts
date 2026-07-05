/**
 * The single clock. Every timestamp the core writes is ISO-8601, UTC,
 * millisecond precision, explicit `Z` — exactly what `Date#toISOString`
 * produces and what the schema's columns expect. The core stamps the mutation
 * timestamps through here — `updated_at`, `completed_at`, and, since MMR-173, a
 * transition's `at` and an annotation's `created_at` — so both backends agree on
 * them rather than letting a per-backend DB default decide. Node/project/tag
 * *creation* `created_at` (and the create-path `updated_at`) still take the
 * SQLite column default — a separate, known backend divergence the conformance
 * harness normalizes; the defaults' ISO/ms format matches this clock.
 */
export function now(): string {
  return new Date().toISOString();
}
