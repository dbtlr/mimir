import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  Size,
  TagEntityType,
  TransitionKind,
} from '@mimir/contract';

/**
 * The backend-neutral domain model (ADR 0016 Phase 0) — the record shapes the
 * core reads and derives over, owned by the core rather than any storage
 * layer. `db/schema.ts` asserts its SQLite row types stay assignable to these,
 * so a Kysely result satisfies the model structurally with no mapping; a
 * future backend only has to produce the same shapes.
 *
 * Field names remain the store's snake_case vocabulary — they are the wire
 * projection's bare-field names too (output-contract reference), not a
 * SQLite-ism.
 */

export type Project = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  last_seq: number;
  last_artifact_seq: number;
  /** The archived operator axis (ADR 0015): NULL = active, set = archived (doubles as "when"). */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Node = {
  id: number;
  project_id: number;
  type: NodeType;
  parent_id: number | null;
  seq: number;
  title: string;
  description: string | null;

  // task-only (NULL for initiative/phase)
  lifecycle: Lifecycle | null;
  hold: Hold | null;
  hold_reason: string | null;
  priority: Priority | null;
  size: Size | null;
  rank: number | null;
  external_ref: string | null;
  completed_at: string | null;

  // phase-only
  target: string | null;

  created_at: string;
  updated_at: string;
};

/** A prerequisite edge: `node_id` waits on `depends_on_node_id`. */
export type Dependency = {
  node_id: number;
  depends_on_node_id: number;
};

export type Annotation = {
  id: number;
  node_id: number;
  content: string;
  created_at: string;
};

export type Artifact = {
  id: number;
  project_id: number;
  seq: number;
  title: string;
  content: string;
  created_at: string;
};

export type ArtifactLink = {
  artifact_id: number;
  node_id: number;
};

export type Tag = {
  entity_type: TagEntityType;
  entity_id: number;
  tag: string;
  note: string | null;
  created_at: string;
};

// Entity-keyed (ADR 0015): exactly one of node_id / project_id is set.
export type TransitionRow = {
  id: number;
  node_id: number | null;
  project_id: number | null;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  at: string;
  reason: string | null;
};
