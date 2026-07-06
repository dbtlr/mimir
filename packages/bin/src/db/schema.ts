import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  Size,
  TagEntityType,
  TransitionKind,
} from '@mimir/contract';
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

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

/** A nullable column omittable on insert (defaults to NULL) — e.g. the entity-keyed log's node_id/project_id. */
type NullableInsert<T> = ColumnType<T | null, T | null | undefined, T | null>;

type ProjectTable = {
  id: Generated<number>;
  key: string;
  name: string;
  description: string | null;
  last_seq: Defaulted<number>;
  last_artifact_seq: Defaulted<number>;
  // The archived operator axis (ADR 0015): NULL = active, set = archived (doubles as "when").
  archived_at: string | null;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
};

type NodeTable = {
  id: Generated<number>;
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
  completed_at: string | null;

  // phase-only
  target: string | null;

  // container-only (phase/initiative) — opt out of done-rollup (MMR-204).
  open_ended: boolean | null;

  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
};

type DependencyTable = {
  node_id: number;
  depends_on_node_id: number;
};

type AnnotationTable = {
  id: Generated<number>;
  node_id: number;
  content: string;
  created_at: DefaultedTimestamp;
};

type ArtifactTable = {
  id: Generated<number>;
  project_id: number;
  seq: number;
  title: string;
  content: string;
  created_at: DefaultedTimestamp;
};

type ArtifactLinkTable = {
  artifact_id: number;
  node_id: number;
};

type TagTable = {
  entity_type: TagEntityType;
  entity_id: number;
  tag: string;
  note: string | null;
  created_at: DefaultedTimestamp;
};

// Entity-keyed (ADR 0015): exactly one of node_id / project_id is set — node-keyed
// for lifecycle/hold/dependency/move, project-keyed for archive/unarchive.
type TransitionLogTable = {
  id: Generated<number>;
  node_id: NullableInsert<number>;
  project_id: NullableInsert<number>;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  at: DefaultedTimestamp;
  reason: string | null;
};

export type DB = {
  project: ProjectTable;
  node: NodeTable;
  dependency: DependencyTable;
  annotation: AnnotationTable;
  artifact: ArtifactTable;
  artifact_link: ArtifactLinkTable;
  tag: TagTable;
  transition_log: TransitionLogTable;
};

// Row helpers (select/insert/update) for the core to lean on.
export type Project = Selectable<ProjectTable>;
export type NewProject = Insertable<ProjectTable>;
export type ProjectUpdate = Updateable<ProjectTable>;

export type Node = Selectable<NodeTable>;
export type NewNode = Insertable<NodeTable>;
export type NodeUpdate = Updateable<NodeTable>;

export type Dependency = Selectable<DependencyTable>;
export type ArtifactLink = Selectable<ArtifactLinkTable>;
export type Annotation = Selectable<AnnotationTable>;
export type NewAnnotation = Insertable<AnnotationTable>;
export type Artifact = Selectable<ArtifactTable>;
export type NewArtifact = Insertable<ArtifactTable>;
export type Tag = Selectable<TagTable>;
export type NewTag = Insertable<TagTable>;
export type TransitionRow = Selectable<TransitionLogTable>;
export type NewTransitionRow = Insertable<TransitionLogTable>;
