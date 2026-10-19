/** Separate the main conversation from a whole-task worker; preserve the append-only log and its id high-water mark. */
export const statements: readonly string[] = [
  `ALTER TABLE node ADD COLUMN worker_harness text`,
  `ALTER TABLE node ADD COLUMN worker_session text`,
  `CREATE TABLE transition_log_next (
     id integer PRIMARY KEY AUTOINCREMENT,
     node_id text REFERENCES node(id),
     project_key text REFERENCES project(key),
     kind text NOT NULL CHECK (kind IN ('lifecycle', 'hold', 'dependency', 'move', 'archive', 'assignment')),
     from_value text,
     to_value text,
     reason text,
     handles text,
     at text NOT NULL,
     CHECK ((node_id IS NULL) <> (project_key IS NULL)),
     CHECK (kind <> 'assignment' OR node_id IS NOT NULL)
   ) STRICT`,
  `INSERT INTO transition_log_next SELECT * FROM transition_log`,
  `DELETE FROM sqlite_sequence WHERE name = 'transition_log_next'`,
  `INSERT INTO sqlite_sequence (name, seq) SELECT 'transition_log_next', seq FROM sqlite_sequence WHERE name = 'transition_log'`,
  `DROP TABLE transition_log`,
  `ALTER TABLE transition_log_next RENAME TO transition_log`,
  `CREATE INDEX idx_transition_node ON transition_log(node_id, id)`,
  `CREATE INDEX idx_transition_at ON transition_log(at, id)`,
  `CREATE INDEX idx_transition_project ON transition_log(project_key, id)`,
];
