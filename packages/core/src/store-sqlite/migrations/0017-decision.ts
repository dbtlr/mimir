/** Decision records and their owned links (ADR 0043). */
export const statements: readonly string[] = [
  `ALTER TABLE project ADD COLUMN last_decision_seq integer NOT NULL DEFAULT 0`,
  `CREATE TABLE decision (
 id text PRIMARY KEY, project_key text NOT NULL REFERENCES project(key), seq integer NOT NULL,
 question text NOT NULL, options text NOT NULL, recommended integer NOT NULL, taken integer NOT NULL,
 class text NOT NULL CHECK (class IN ('product','architecture','other')), why text,
 delivery text REFERENCES delivery(id), lifecycle text NOT NULL CHECK (lifecycle IN ('provisional','confirmed','overturned')),
 overturn_option integer, outcome_note text, created_at text NOT NULL, updated_at text NOT NULL,
 UNIQUE(project_key, seq)
 ) STRICT`,
  `CREATE TABLE decision_task (decision_id text NOT NULL REFERENCES decision(id), task text NOT NULL REFERENCES node(id), PRIMARY KEY(decision_id, task)) STRICT`,
  `CREATE INDEX idx_decision_task_task ON decision_task(task)`,
  `CREATE TABLE decision_history (id integer PRIMARY KEY AUTOINCREMENT, decision_id text NOT NULL REFERENCES decision(id),
 kind text NOT NULL CHECK (kind IN ('lifecycle','link','delivery')), from_value text, to_value text, reason text, task text REFERENCES node(id), at text NOT NULL
 ) STRICT`,
  `CREATE INDEX idx_decision_history ON decision_history(decision_id, id)`,
];
