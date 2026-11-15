/** Checklist items on tasks, numbered within their task (ADR 0044). */
export const statements: readonly string[] = [
  `CREATE TABLE checklist_item (
 node_id text NOT NULL REFERENCES node(id), number integer NOT NULL, content text NOT NULL,
 state text NOT NULL CHECK (state IN ('open','checked','dropped')), reason text,
 created_at text NOT NULL, settled_at text,
 PRIMARY KEY(node_id, number)
 ) STRICT`,
];
