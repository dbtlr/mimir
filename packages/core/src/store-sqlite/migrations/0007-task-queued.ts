/**
 * Widen node.lifecycle to admit queued reservations. SQLite cannot alter a CHECK,
 * so rebuild node and its foreign-key dependants together. Preserve explicit row
 * ids and AUTOINCREMENT high-water marks, including ids deleted before upgrade.
 * Every vocabulary is frozen to the values this migration introduced.
 */
export const statements: readonly string[] = [
  `CREATE TABLE node_next (
     id           text PRIMARY KEY,
     project_key  text NOT NULL REFERENCES project(key),
     type         text NOT NULL CHECK (type IN ('initiative', 'phase', 'task')),
     parent_id    text REFERENCES node_next(id) DEFERRABLE INITIALLY DEFERRED,
     seq          integer NOT NULL,
     title        text NOT NULL,
     description  text,
     summary      text,
     lifecycle    text CHECK (lifecycle IN ('todo', 'queued', 'in_progress', 'under_review', 'done', 'abandoned')),
     hold         text CHECK (hold IN ('none', 'blocked', 'parked')),
     hold_reason  text,
     priority     text CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
     size         text CHECK (size IN ('small', 'medium', 'large')),
     rank         integer,
     external_ref text,
     upstream     text,
     host         text,
     harness      text,
     session      text,
     branch       text,
     completed_at text,
     target       text,
     open_ended   integer CHECK (open_ended IN (0, 1)),
     next_present integer NOT NULL DEFAULT 0 CHECK (next_present IN (0, 1)),
     next_text    text,
     created_at   text NOT NULL,
     updated_at   text NOT NULL,
     grooming text CHECK (grooming IN ('not_groomed', 'needs_answers', 'groomed')),
     block_owner text CHECK (block_owner IN ('you', 'others')),
     UNIQUE (project_key, seq)
   ) STRICT`,
  `INSERT INTO node_next (id, project_key, type, parent_id, seq, title, description, summary, lifecycle, hold, hold_reason, priority, size, rank, external_ref, upstream, host, harness, session, branch, completed_at, target, open_ended, next_present, next_text, created_at, updated_at, grooming, block_owner) SELECT id, project_key, type, parent_id, seq, title, description, summary, lifecycle, hold, hold_reason, priority, size, rank, external_ref, upstream, host, harness, session, branch, completed_at, target, open_ended, next_present, next_text, created_at, updated_at, grooming, block_owner FROM node`,
  `CREATE TABLE dependency_next (
     node_id            text NOT NULL REFERENCES node_next(id),
     depends_on_node_id text NOT NULL REFERENCES node_next(id),
     PRIMARY KEY (node_id, depends_on_node_id),
     CHECK (node_id <> depends_on_node_id)
   ) STRICT`,

  `INSERT INTO dependency_next SELECT * FROM dependency`,
  `CREATE TABLE annotation_next (
     id         integer PRIMARY KEY AUTOINCREMENT,
     node_id    text NOT NULL REFERENCES node_next(id),
     content    text NOT NULL,
     created_at text NOT NULL
   ) STRICT`,

  `INSERT INTO annotation_next SELECT * FROM annotation`,
  `DELETE FROM sqlite_sequence WHERE name = 'annotation_next'`,
  `INSERT INTO sqlite_sequence (name, seq) SELECT 'annotation_next', seq FROM sqlite_sequence WHERE name = 'annotation'`,
  `CREATE TABLE artifact_link_next (
     artifact_id text NOT NULL REFERENCES artifact(id),
     node_id     text NOT NULL REFERENCES node_next(id),
     PRIMARY KEY (artifact_id, node_id)
   ) STRICT`,

  `INSERT INTO artifact_link_next SELECT * FROM artifact_link`,
  `CREATE TABLE transition_log_next (
     id          integer PRIMARY KEY AUTOINCREMENT,
     node_id     text REFERENCES node_next(id),
     project_key text REFERENCES project(key),
     kind        text NOT NULL CHECK (kind IN ('lifecycle', 'hold', 'dependency', 'move', 'archive')),
     from_value  text,
     to_value    text,
     reason      text,
     handles     text,
     at          text NOT NULL,
     CHECK ((node_id IS NULL) <> (project_key IS NULL))
   ) STRICT`,

  `INSERT INTO transition_log_next SELECT * FROM transition_log`,
  `DELETE FROM sqlite_sequence WHERE name = 'transition_log_next'`,
  `INSERT INTO sqlite_sequence (name, seq) SELECT 'transition_log_next', seq FROM sqlite_sequence WHERE name = 'transition_log'`,
  `DROP TABLE dependency`,
  `DROP TABLE annotation`,
  `DROP TABLE artifact_link`,
  `DROP TABLE transition_log`,
  `DROP TABLE node`,
  `ALTER TABLE node_next RENAME TO node`,
  `ALTER TABLE dependency_next RENAME TO dependency`,
  `ALTER TABLE annotation_next RENAME TO annotation`,
  `ALTER TABLE artifact_link_next RENAME TO artifact_link`,
  `ALTER TABLE transition_log_next RENAME TO transition_log`,
  `CREATE INDEX idx_node_parent ON node(parent_id)`,
  `CREATE INDEX idx_node_project ON node(project_key)`,
  `CREATE INDEX idx_annotation_node ON annotation(node_id)`,
  `CREATE INDEX idx_artifact_link_node ON artifact_link(node_id)`,
  `CREATE INDEX idx_transition_node ON transition_log(node_id, id)`,
  `CREATE INDEX idx_transition_at ON transition_log(at, id)`,
  `CREATE INDEX idx_transition_project ON transition_log(project_key, id)`,
];
