import type {
  ExecutionHandles,
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  ScratchpadAgendaItem,
  ScratchpadJournalEntry,
  SeedKind,
  SeedLifecycle,
  Size,
  TagEntityType,
  TransitionKind,
} from '@mimir/contract';
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * The relational shape of the Postgres store (ADR 0030) — the Kysely table
 * types the whole backend is written against.
 *
 * Two representational commitments, both deliberate:
 *
 * - **The external stem is the primary key.** `KEY`, `KEY-seq`, `KEY-aN`,
 *   `KEY-sN`, and a scratchpad's UUID are the identities the `Store` seam
 *   speaks, so they are the identities the rows carry. There is no surrogate
 *   integer id to translate at the boundary, and the primary key is therefore
 *   what makes `hasIdentityCollision` structurally false.
 * - **Timestamps are `text`, never `timestamptz`.** Every instant the core
 *   writes is a canonical ISO-8601 UTC string (`core/time.ts`), the transfer
 *   document carries it verbatim, and lexical comparison of two stored values
 *   is chronological by that invariant. A `timestamptz` round trip would
 *   reformat the value and make a Norn export and a Postgres export of the same
 *   store differ.
 */

/**
 * A `bigserial` surrogate key — the one place this schema uses a machine id,
 * for the append-only logs whose ORDER is the fact. Read back as `string` from
 * node-postgres and `number` from PGlite, so the read path normalizes.
 */
type RowId = ColumnType<string | number, undefined, never>;

/** A `jsonb` column: parsed on read, handed back as JSON text on write. */
type Json<T> = ColumnType<T, string, string>;

export type ProjectTable = {
  key: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  last_seq: Generated<number>;
  last_artifact_seq: Generated<number>;
  last_seed_seq: Generated<number>;
  next_present: Generated<boolean>;
  next_text: string | null;
  created_at: string;
  updated_at: string;
};

export type NodeTable = {
  /** `KEY-seq`. */
  id: string;
  project_key: string;
  type: NodeType;
  parent_id: string | null;
  seq: number;
  title: string;
  description: string | null;
  summary: string | null;
  lifecycle: Lifecycle | null;
  hold: Hold | null;
  hold_reason: string | null;
  priority: Priority | null;
  size: Size | null;
  rank: number | null;
  external_ref: string | null;
  upstream: string | null;
  host: string | null;
  harness: string | null;
  session: string | null;
  branch: string | null;
  completed_at: string | null;
  target: string | null;
  open_ended: boolean | null;
  next_present: Generated<boolean>;
  next_text: string | null;
  created_at: string;
  updated_at: string;
};

export type DependencyTable = {
  node_id: string;
  depends_on_node_id: string;
};

export type AnnotationTable = {
  id: RowId;
  node_id: string;
  content: string;
  created_at: string;
};

export type ArtifactTable = {
  /** `KEY-aN`. */
  id: string;
  project_key: string;
  seq: number;
  title: string;
  summary: string | null;
  /** Stored WITHOUT a trailing newline — the seam's read-back form. */
  content: string;
  source_scratch: string | null;
  created_at: string;
  updated_at: string;
};

export type ArtifactLinkTable = {
  artifact_id: string;
  node_id: string;
};

/**
 * One tag application. There is no `created_at`: the seam synthesizes a tag's
 * timestamp from the owning entity's own `created_at` (ADR 0005, Norn parity),
 * and storing a second copy would be two sources for one fact.
 */
export type TagTable = {
  entity_type: TagEntityType;
  /** A project key, a node stem, or an artifact stem. */
  entity_id: string;
  tag: string;
};

export type TransitionLogTable = {
  id: RowId;
  node_id: string | null;
  project_key: string | null;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  handles: ColumnType<ExecutionHandles | null, string | null, string | null>;
  at: string;
};

export type SeedTable = {
  /** `KEY-sN`. */
  id: string;
  project_key: string;
  seq: number;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  requester: string | null;
  description: string | null;
  spawned: Generated<string[]>;
  created_at: string;
  updated_at: string;
};

export type SeedHistoryTable = {
  id: RowId;
  seed_id: string;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  at: string;
};

export type ScratchpadTable = {
  /** A canonical lowercase UUIDv4. */
  id: string;
  project_key: string;
  title: string;
  anchors: Generated<string[]>;
  journal: Json<ScratchpadJournalEntry[]>;
  agenda: Json<ScratchpadAgendaItem[]>;
  freezing_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SchemaVersionTable = {
  version: number;
  applied_at: string;
};

export type DB = {
  annotation: AnnotationTable;
  artifact: ArtifactTable;
  artifact_link: ArtifactLinkTable;
  dependency: DependencyTable;
  node: NodeTable;
  project: ProjectTable;
  schema_version: SchemaVersionTable;
  scratchpad: ScratchpadTable;
  seed: SeedTable;
  seed_history: SeedHistoryTable;
  tag: TagTable;
  transition_log: TransitionLogTable;
};

export type ProjectRow = Selectable<ProjectTable>;
export type NodeRow = Selectable<NodeTable>;
export type ArtifactRow = Selectable<ArtifactTable>;
export type SeedRow = Selectable<SeedTable>;
export type ScratchpadRow = Selectable<ScratchpadTable>;
export type NodeUpdate = Updateable<NodeTable>;
export type ProjectUpdate = Updateable<ProjectTable>;
export type NodeInsert = Insertable<NodeTable>;

/** Normalize a `bigserial` surrogate key, whichever shape the driver yields. */
export function toRowId(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}
