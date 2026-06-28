import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';

/**
 * The initial schema — the DDL from `docs/schema-reference.md` verbatim,
 * realizing ADRs 0001–0008. Forward-only (no `down`). Each statement runs on
 * its own via Kysely's `sql` tag.
 *
 * Design notes live in the schema reference; the load-bearing shape:
 * - `project` is its own table (owns `key` + `last_seq` allocation), not a node.
 * - `node` is one typed adjacency tree; type-specific fields are nullable
 *   columns and row-local CHECKs make structurally-illegal rows unrepresentable
 *   (the DB owns row integrity; the core owns behavioral invariants).
 * - `dependency` edges drive derived ready/awaiting/blocking — never stored.
 * - `transition_log` is written in the same tx as every status-bearing change.
 * - All timestamps are ISO-8601 UTC, millisecond precision, explicit `Z`.
 */
export const migration: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await sql`
      CREATE TABLE project (
        id         INTEGER PRIMARY KEY,
        key        TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        repo       TEXT,
        path       TEXT,
        last_seq   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (length(key) BETWEEN 2 AND 4 AND key GLOB '[A-Z]*')
      )
    `.execute(db);

    await sql`
      CREATE TABLE node (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES project(id),
        type         TEXT NOT NULL CHECK (type IN ('initiative','phase','task')),
        parent_id    INTEGER REFERENCES node(id),
        seq          INTEGER NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT,

        lifecycle    TEXT CHECK (lifecycle IN ('todo','in_progress','done','abandoned')),
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

    await sql`CREATE INDEX idx_node_tree       ON node(project_id, parent_id)`.execute(db);
    await sql`CREATE INDEX idx_node_type       ON node(project_id, type)`.execute(db);
    await sql`CREATE INDEX idx_node_rank       ON node(project_id, rank)`.execute(db);
    await sql`CREATE INDEX idx_node_actionable ON node(project_id, lifecycle, hold)`.execute(db);

    await sql`
      CREATE TABLE dependency (
        node_id            INTEGER NOT NULL REFERENCES node(id),
        depends_on_node_id INTEGER NOT NULL REFERENCES node(id),
        PRIMARY KEY (node_id, depends_on_node_id),
        CHECK (node_id != depends_on_node_id)
      )
    `.execute(db);
    await sql`CREATE INDEX idx_dependency_reverse ON dependency(depends_on_node_id)`.execute(db);

    await sql`
      CREATE TABLE annotation (
        id         INTEGER PRIMARY KEY,
        node_id    INTEGER NOT NULL REFERENCES node(id),
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `.execute(db);
    await sql`CREATE INDEX idx_annotation_node ON annotation(node_id)`.execute(db);

    await sql`
      CREATE TABLE artifact (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id),
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `.execute(db);

    await sql`
      CREATE TABLE artifact_link (
        artifact_id INTEGER NOT NULL REFERENCES artifact(id),
        node_id     INTEGER NOT NULL REFERENCES node(id),
        PRIMARY KEY (artifact_id, node_id)
      )
    `.execute(db);
    await sql`CREATE INDEX idx_artifact_link_node ON artifact_link(node_id)`.execute(db);

    await sql`
      CREATE TABLE tag (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('project','node','artifact')),
        entity_id   INTEGER NOT NULL,
        tag         TEXT NOT NULL,
        note        TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (entity_type, entity_id, tag)
      )
    `.execute(db);
    await sql`CREATE INDEX idx_tag_lookup ON tag(tag, created_at)`.execute(db);

    await sql`
      CREATE TABLE transition_log (
        id         INTEGER PRIMARY KEY,
        node_id    INTEGER NOT NULL REFERENCES node(id),
        kind       TEXT NOT NULL CHECK (kind IN ('lifecycle','hold','dependency','move')),
        from_value TEXT,
        to_value   TEXT,
        at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reason     TEXT
      )
    `.execute(db);
    await sql`CREATE INDEX idx_transition_node ON transition_log(node_id, at)`.execute(db);
  },
};
