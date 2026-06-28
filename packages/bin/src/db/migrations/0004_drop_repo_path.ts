import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Drop `project.repo` / `project.path` (MMR-44, ADR 0011). A stored filesystem
 * path pins a project to one machine — the store knows no paths; the repo →
 * project binding lives repo-side in a checked-in `.mimir.toml` instead. Both
 * columns were write-only vestiges (never rendered by the read surface), so
 * this loses no behavior. Plain nullable TEXT columns with no index/constraint
 * references — SQLite's `DROP COLUMN` applies, no table rebuild needed.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE project DROP COLUMN repo`.execute(db);
    await sql`ALTER TABLE project DROP COLUMN path`.execute(db);
  },
};
