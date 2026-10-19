/** Separate the main conversation from a whole-task worker and audit identity changes. */
export const statements: readonly string[] = [
  `ALTER TABLE node ADD COLUMN worker_harness text`,
  `ALTER TABLE node ADD COLUMN worker_session text`,
  `ALTER TABLE transition_log ADD CONSTRAINT transition_log_assignment_node_check CHECK (kind <> 'assignment' OR node_id IS NOT NULL)`,
  `ALTER TABLE transition_log DROP CONSTRAINT transition_log_kind_check`,
  `ALTER TABLE transition_log ADD CONSTRAINT transition_log_kind_check CHECK (kind IN ('lifecycle', 'hold', 'dependency', 'move', 'archive', 'assignment'))`,
];
