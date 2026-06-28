import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * Required artifact `title` (MMR-34): classification-by-tag isn't enforced,
 * so a human handle is the floor every artifact must meet. NOT NULL needs a
 * table rebuild (same dance as 0002); existing rows backfill from the first
 * markdown heading in the content, falling back to "untitled".
 */

function titleFrom(content: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content);
  const title = heading?.[1]?.trim();
  return title !== undefined && title !== '' ? title : 'untitled';
}

export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`
      CREATE TABLE artifact_new (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id),
        seq        INTEGER NOT NULL,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (project_id, seq)
      )
    `.execute(db);

    const { rows } = await sql<{
      id: number;
      project_id: number;
      seq: number;
      content: string;
      created_at: string;
    }>`SELECT id, project_id, seq, content, created_at FROM artifact`.execute(db);
    for (const row of rows) {
      await sql`
        INSERT INTO artifact_new (id, project_id, seq, title, content, created_at)
        VALUES (${row.id}, ${row.project_id}, ${row.seq}, ${titleFrom(row.content)},
                ${row.content}, ${row.created_at})
      `.execute(db);
    }

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
  },
};
