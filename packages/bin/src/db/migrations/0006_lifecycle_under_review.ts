import { type Kysely, type Migration, sql } from "kysely";

/**
 * Widen the `node.lifecycle` CHECK to admit `under_review` (MMR-84) — the
 * optional ship-readiness gate between `in_progress` and `done`.
 *
 * SQLite can't ALTER a column CHECK in place, so the table is rebuilt. The
 * SQLite adapter reports `supportsTransactionalDdl = false`, so migrations run
 * in autocommit — which lets us toggle `PRAGMA foreign_keys = OFF` for the swap
 * (a no-op inside a transaction). With FK enforcement off we can drop and
 * recreate `node` without disturbing the four child tables that reference it
 * (`dependency`, `annotation`, `artifact_link`, `transition_log`) or the
 * self-referential `parent_id`: every `id` is copied verbatim, so referential
 * integrity holds by construction once the new table takes the `node` name.
 *
 * The change only *widens* the constraint, so existing rows stay valid — no
 * data transform, just a schema swap.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`PRAGMA foreign_keys = OFF`.execute(db);

    await sql`
      CREATE TABLE node_new (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES project(id),
        type         TEXT NOT NULL CHECK (type IN ('initiative','phase','task')),
        parent_id    INTEGER REFERENCES node(id),
        seq          INTEGER NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT,

        lifecycle    TEXT CHECK (lifecycle IN ('todo','in_progress','under_review','done','abandoned')),
        hold         TEXT CHECK (hold IN ('none','blocked','parked')),
        hold_reason  TEXT,
        priority     TEXT CHECK (priority IN ('p0','p1','p2','p3')),
        size         TEXT CHECK (size IN ('small','medium','large')),
        rank         INTEGER,
        external_ref TEXT,
        completed_at TEXT,

        target       TEXT,

        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

        CHECK (type = 'task'  OR (lifecycle IS NULL AND hold IS NULL AND hold_reason IS NULL
                                  AND priority IS NULL AND size IS NULL AND rank IS NULL
                                  AND completed_at IS NULL AND external_ref IS NULL)),
        CHECK (type = 'phase' OR target IS NULL),
        CHECK (type != 'task' OR (lifecycle IS NOT NULL AND hold IS NOT NULL)),

        UNIQUE (project_id, seq)
      )
    `.execute(db);

    await sql`INSERT INTO node_new SELECT * FROM node`.execute(db);
    await sql`DROP TABLE node`.execute(db);
    await sql`ALTER TABLE node_new RENAME TO node`.execute(db);

    await sql`CREATE INDEX idx_node_tree       ON node(project_id, parent_id)`.execute(db);
    await sql`CREATE INDEX idx_node_type       ON node(project_id, type)`.execute(db);
    await sql`CREATE INDEX idx_node_rank       ON node(project_id, rank)`.execute(db);
    await sql`CREATE INDEX idx_node_actionable ON node(project_id, lifecycle, hold)`.execute(db);

    await sql`PRAGMA foreign_keys = ON`.execute(db);
  },
};
