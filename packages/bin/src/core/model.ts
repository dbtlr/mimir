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
 * core reads and derives over, owned by the core rather than the storage layer.
 * The Norn store (`store-norn.ts`) projects the vault's frontmatter into these
 * shapes; the model owns the contract, not the store.
 *
 * Field names are the store's snake_case vocabulary — they are the wire
 * projection's bare-field names too (output-contract reference).
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
  /** The short list lede (MMR-162) — all-node, never type-gated (unlike `external_ref`). */
  summary: string | null;

  // task-only (NULL for initiative/phase)
  lifecycle: Lifecycle | null;
  hold: Hold | null;
  hold_reason: string | null;
  priority: Priority | null;
  size: Size | null;
  rank: number | null;
  external_ref: string | null;
  /** The requester-side pointer at a seed (`KEY-sN`), nullable (MMR-244). Reference
   * only in v1 (explicit block/unblock on the requester task); a gating cross-project
   * dependency is deferred. Round-trips through the vault like `external_ref`. */
  upstream: string | null;
  completed_at: string | null;

  // phase-only
  target: string | null;

  // container-only (phase/initiative) — purposefully open-ended: opt out of
  // done-rollup, never reduces to done/abandoned (MMR-204).
  open_ended: boolean | null;

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
