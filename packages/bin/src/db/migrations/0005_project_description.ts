import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Add `description TEXT NULL` to the `project` table (MMR-88). Projects are
 * the only first-class entity that lacked a description; this mirrors the
 * nullable `description` column every `node` row already carries. A plain
 * nullable TEXT column with no index/constraint references — SQLite's
 * `ADD COLUMN` applies, no table rebuild needed.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE project ADD COLUMN description TEXT`.execute(db);
  },
};
