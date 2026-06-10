import { type Kysely, type Migration, sql } from "kysely";

/**
 * Artifact addressability (MMR-32): artifacts get a per-project `seq` so they
 * render as `KEY-aN` — project-scoped like nodes, replacing the global `#N`
 * echo. `project.last_artifact_seq` is the allocator (allocation, not
 * derivation — the same carve-out as `node.seq`).
 *
 * SQLite can't add a NOT NULL column without a table rebuild, so `artifact` is
 * rebuilt. `artifact_link` (the only child) is dropped first and recreated
 * after the rename so `foreign_keys = ON` never sees a dangling reference.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`ALTER TABLE project ADD COLUMN last_artifact_seq INTEGER NOT NULL DEFAULT 0`.execute(
      db,
    );

    await sql`
      CREATE TABLE artifact_new (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id),
        seq        INTEGER NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (project_id, seq)
      )
    `.execute(db);
    await sql`
      INSERT INTO artifact_new (id, project_id, seq, content, created_at)
      SELECT id, project_id,
             ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id),
             content, created_at
      FROM artifact
    `.execute(db);

    await sql`CREATE TABLE artifact_link_backup AS SELECT * FROM artifact_link`.execute(db);
    await sql`DROP TABLE artifact_link`.execute(db);
    await sql`DROP TABLE artifact`.execute(db);
    await sql`ALTER TABLE artifact_new RENAME TO artifact`.execute(db);

    await sql`
      CREATE TABLE artifact_link (
        artifact_id INTEGER NOT NULL REFERENCES artifact(id),
        node_id     INTEGER NOT NULL REFERENCES node(id),
        PRIMARY KEY (artifact_id, node_id)
      )
    `.execute(db);
    await sql`
      INSERT INTO artifact_link (artifact_id, node_id)
      SELECT artifact_id, node_id FROM artifact_link_backup
    `.execute(db);
    await sql`DROP TABLE artifact_link_backup`.execute(db);
    await sql`CREATE INDEX idx_artifact_link_node ON artifact_link(node_id)`.execute(db);

    await sql`
      UPDATE project SET last_artifact_seq =
        COALESCE((SELECT MAX(seq) FROM artifact WHERE artifact.project_id = project.id), 0)
    `.execute(db);
  },
};
