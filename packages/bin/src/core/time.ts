/**
 * The single clock. Every timestamp the core writes is ISO-8601, UTC,
 * millisecond precision, explicit `Z` — exactly what `Date#toISOString`
 * produces and what the schema's columns expect. The core stamps the mutation
 * timestamps through here — `updated_at`, `completed_at`, and, since MMR-173, a
 * transition's `at` and an annotation's `created_at` — rather than letting a
 * storage-layer default decide. Node/project/tag *creation* `created_at` (and
 * the create-path `updated_at`) still take the vault's own generated default
 * rather than this clock — a known divergence the conformance harness
 * normalizes; the default's ISO/ms format matches this clock.
 */
export function now(): string {
  return new Date().toISOString();
}
