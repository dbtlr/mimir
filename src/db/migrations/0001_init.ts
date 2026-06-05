import type { Migration } from "kysely";

/**
 * Phase 0: an intentionally-empty migration. It exists so the Migrator has
 * something to apply under its lock (the scaffold exit criterion) and so the
 * `kysely_migration` bookkeeping is exercised end to end.
 *
 * Phase 1 fills this `up` with the schema reference's DDL verbatim — every
 * table, row-local CHECK, and index from `notes/mimir-schema-reference.md`,
 * emitted as raw SQL via Kysely's `sql` tag. Forward-only: no `down`.
 */
export const migration: Migration = {
  // No-op for now; resolves immediately. Param omitted so there is no unused
  // `db` to lint, and non-`async` so there is no missing-await to lint.
  up: () => Promise.resolve(),
};
