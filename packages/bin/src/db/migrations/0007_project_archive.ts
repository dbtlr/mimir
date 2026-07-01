import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Project archive (ADR 0015). Two schema changes:
 *
 * 1. `project.archived_at` — a nullable timestamp (NULL = active, set = archived).
 *    The project's first stored operator axis; a plain nullable column, so
 *    SQLite's `ADD COLUMN` applies with no rebuild.
 *
 * 2. `transition_log` generalized from node-keyed to **entity-keyed** — `node_id`
 *    becomes nullable, a nullable `project_id` is added, an XOR check enforces
 *    exactly one, and `kind` gains `'archive'`. That's a nullability + CHECK
 *    change, which SQLite can't do in place, so the table is rebuilt (same
 *    swap as 0006): `PRAGMA foreign_keys = OFF` (effective only in autocommit —
 *    the SQLite adapter runs migrations without a wrapping transaction), copy
 *    rows verbatim, drop, rename. Existing rows all have `node_id` set /
 *    `project_id` NULL, valid under the new XOR, so there's no data transform.
 *    Nothing references `transition_log`, so no child table is disturbed.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE project ADD COLUMN archived_at TEXT`.execute(db);

    // Autocommit makes the PRAGMA effective; a mid-flight throw aborts startup
    // and the next open re-applies the connection PRAGMAs (see 0006).
    await sql`PRAGMA foreign_keys = OFF`.execute(db);

    await sql`
      CREATE TABLE transition_log_new (
        id         INTEGER PRIMARY KEY,
        node_id    INTEGER REFERENCES node(id),
        project_id INTEGER REFERENCES project(id),
        kind       TEXT NOT NULL CHECK (kind IN ('lifecycle','hold','dependency','move','archive')),
        from_value TEXT,
        to_value   TEXT,
        at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reason     TEXT,
        CHECK ((node_id IS NOT NULL) <> (project_id IS NOT NULL))
      )
    `.execute(db);

    await sql`
      INSERT INTO transition_log_new (id, node_id, project_id, kind, from_value, to_value, at, reason)
      SELECT id, node_id, NULL, kind, from_value, to_value, at, reason FROM transition_log
    `.execute(db);
    await sql`DROP TABLE transition_log`.execute(db);
    await sql`ALTER TABLE transition_log_new RENAME TO transition_log`.execute(db);

    await sql`CREATE INDEX idx_transition_node    ON transition_log(node_id, at)`.execute(db);
    await sql`CREATE INDEX idx_transition_project ON transition_log(project_id, at)`.execute(db);

    await sql`PRAGMA foreign_keys = ON`.execute(db);
  },
};
