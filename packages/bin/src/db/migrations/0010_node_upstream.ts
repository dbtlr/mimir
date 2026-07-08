import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Add `upstream TEXT NULL` to the `node` table (MMR-244) — the requester-side
 * pointer at a seed (`KEY-sN`), nullable, round-tripping like `external_ref`.
 * Task-oriented in practice, but — like `open_ended` (0009) — enforced at the
 * verb layer, not by a CHECK: SQLite's `ADD COLUMN` cannot carry one and the
 * field has no invariants to guard. A plain nullable column with no index, so
 * `ADD COLUMN` applies with no table rebuild.
 *
 * Seeds themselves are Norn-only (MMR-234) and never grow a SQLite table; this
 * column exists solely so the shared domain model stays assignable to the SQLite
 * row type while the SQLite backend is retired.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE node ADD COLUMN upstream TEXT`.execute(db);
  },
};
