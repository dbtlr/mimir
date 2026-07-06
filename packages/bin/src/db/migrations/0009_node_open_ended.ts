import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Add `open_ended INTEGER NULL` to the `node` table (MMR-204). A container-only
 * (phase/initiative) opt-out of done-rollup — a "dumb field, no invariants"
 * (ADR 0001/0008 refinement): it changes status *derivation*, not any stored
 * transition. SQLite has no boolean type, so it lands as a nullable INTEGER
 * (0/1/NULL); the read boundary coerces it back to a real boolean so the model
 * (`boolean | null`) and the Norn backend agree (see `store-sqlite.ts`).
 *
 * Container-only is enforced at the verb layer (create/update reject it on a
 * task), not by a CHECK — SQLite's `ADD COLUMN` cannot carry one, and the field
 * has no invariants to guard. A plain nullable column with no index reference,
 * so `ADD COLUMN` applies with no table rebuild.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE node ADD COLUMN open_ended INTEGER`.execute(db);
  },
};
