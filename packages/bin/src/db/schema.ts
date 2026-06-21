import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  Size,
  TagEntityType,
  TransitionKind,
} from "@mimir/contract";

/**
 * The Kysely database interface — the typed shape of every table, realizing
 * `docs/schema-reference.md` / `migrations/0001_init`. The core is
 * storage-committed: it queries this `Kysely<DB>` directly.
 */

/**
 * A timestamp column the DB defaults on insert: ISO-8601 UTC, ms precision,
 * explicit `Z`. Selected as a string; omittable on insert (DB fills it); the
 * core supplies it explicitly on update (`updated_at`).
 */
type DefaultedTimestamp = ColumnType<string, string | undefined, string>;

/** A column with a DB DEFAULT: required on read, optional on insert. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

interface ProjectTable {
  id: Generated<number>;
  key: string;
  name: string;
  description: string | null;
  last_seq: Defaulted<number>;
  last_artifact_seq: Defaulted<number>;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
}

interface NodeTable {
  id: Generated<number>;
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

  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
}

interface DependencyTable {
  node_id: number;
  depends_on_node_id: number;
}

interface AnnotationTable {
  id: Generated<number>;
  node_id: number;
  content: string;
  created_at: DefaultedTimestamp;
}

interface ArtifactTable {
  id: Generated<number>;
  project_id: number;
  seq: number;
  title: string;
  content: string;
  created_at: DefaultedTimestamp;
}

interface ArtifactLinkTable {
  artifact_id: number;
  node_id: number;
}

interface TagTable {
  entity_type: TagEntityType;
  entity_id: number;
  tag: string;
  note: string | null;
  created_at: DefaultedTimestamp;
}

interface TransitionLogTable {
  id: Generated<number>;
  node_id: number;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  at: DefaultedTimestamp;
  reason: string | null;
}

export interface DB {
  project: ProjectTable;
  node: NodeTable;
  dependency: DependencyTable;
  annotation: AnnotationTable;
  artifact: ArtifactTable;
  artifact_link: ArtifactLinkTable;
  tag: TagTable;
  transition_log: TransitionLogTable;
}

// Row helpers (select/insert/update) for the core to lean on.
export type Project = Selectable<ProjectTable>;
export type NewProject = Insertable<ProjectTable>;
export type ProjectUpdate = Updateable<ProjectTable>;

export type Node = Selectable<NodeTable>;
export type NewNode = Insertable<NodeTable>;
export type NodeUpdate = Updateable<NodeTable>;

export type Dependency = Selectable<DependencyTable>;
export type Annotation = Selectable<AnnotationTable>;
export type NewAnnotation = Insertable<AnnotationTable>;
export type Artifact = Selectable<ArtifactTable>;
export type NewArtifact = Insertable<ArtifactTable>;
export type Tag = Selectable<TagTable>;
export type NewTag = Insertable<TagTable>;
export type TransitionRow = Selectable<TransitionLogTable>;
export type NewTransitionRow = Insertable<TransitionLogTable>;
