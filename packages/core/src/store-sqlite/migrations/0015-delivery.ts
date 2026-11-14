/** Delivery record vocabulary is frozen at migration 0015. */
export const statements: readonly string[] = [
  `ALTER TABLE project ADD COLUMN last_delivery_seq integer NOT NULL DEFAULT 0`,
  `CREATE TABLE delivery (
 id text PRIMARY KEY, project_key text NOT NULL REFERENCES project(key), seq integer NOT NULL,
 phase text NOT NULL REFERENCES node(id), title text NOT NULL,
 lifecycle text NOT NULL DEFAULT 'agreed' CHECK (lifecycle IN ('agreed','running','milestone','landed','abandoned')),
 hold text NOT NULL DEFAULT 'none' CHECK (hold IN ('none','stopped','paused')), hold_reason text,
 agreement text, external_ref text, branch text, host text, harness text, session text,
 time_cap_minutes integer CHECK (time_cap_minutes > 0), created_at text NOT NULL, updated_at text NOT NULL,
 UNIQUE(project_key, seq)
 ) STRICT`,
  `CREATE TABLE delivery_history (
 id integer PRIMARY KEY AUTOINCREMENT, delivery_id text NOT NULL REFERENCES delivery(id),
 kind text NOT NULL CHECK (kind IN ('lifecycle','hold','member')),
 from_value text, to_value text, reason text, task text REFERENCES node(id), at text NOT NULL
 ) STRICT`,
  `CREATE INDEX idx_delivery_history ON delivery_history(delivery_id, id)`,
];
