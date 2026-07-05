import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Add `summary TEXT NULL` to the `node` table (MMR-162). The short list
 * lede — all-node (task/phase/initiative), never type-gated, structurally
 * identical to the existing nullable `description` column. A plain nullable
 * TEXT column with no index/constraint references — SQLite's `ADD COLUMN`
 * applies, no table rebuild needed.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE node ADD COLUMN summary TEXT`.execute(db);
  },
};
