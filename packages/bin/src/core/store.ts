import type {
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  Size,
  TagEntityType,
  TransitionKind,
} from '@mimir/contract';

import type { ArtifactStore } from './artifacts/store';
import type { Db } from './context';
import type { Artifact, Dependency, Node, Project, Tag } from './model';

/**
 * The coarse storage seam (ADR 0016 Phase 0). The core reads work state as
 * bulk projections — O(views) store queries, never O(nodes) — and derives
 * everything else in memory; writes run inside `transact`, composing the
 * `StoreWriter` primitives. A backend implements this interface; SQLite is
 * the lone implementation today (`createSqliteStore`).
 */

/**
 * One bulk projection of the whole store's derivation inputs: every project
 * (including archived — `archived_at` carries the axis), every node, every
 * dependency edge, and the node tag sets.
 *
 * Deliberately whole-store, not per-project: dependency edges cross project
 * boundaries (ADR 0015 Refinement settles archived prerequisites for exactly
 * that reason), so a project-scoped load would need the transitive dependency
 * closure — subtree, lineage, and edges of every out-of-scope prerequisite —
 * to derive correctly. At single-operator scale the whole store is a handful
 * of cheap queries; scope filtering happens in memory.
 */
/** A node's tag record inside the working set — the tag facet's full shape. */
export type NodeTag = Pick<Tag, 'tag' | 'note' | 'created_at'>;

export type WorkingSet = {
  /** Every project, key-ordered, archived included. */
  projects: readonly Project[];
  nodes: readonly Node[];
  edges: readonly Dependency[];
  /** Node id → its tag records in `created_at` order. Absent = untagged. */
  nodeTags: ReadonlyMap<number, readonly NodeTag[]>;
  /** Project id → its tag records in `created_at` order. Absent = untagged. */
  projectTags: ReadonlyMap<number, readonly NodeTag[]>;
};

// ---------------------------------------------------------------------------
// Write records — the backend-neutral shapes the verbs hand the writer.
// Patterned like `model.ts` (snake_case store vocabulary) and structurally
// compatible with Kysely's Insertable/Updateable, so the SQLite backend
// passes them straight through.
// ---------------------------------------------------------------------------

export type NewProjectRecord = {
  key: string;
  name: string;
  description: string | null;
};

/** The mutable project columns — `key` and the counters are immutable/allocated. */
export type ProjectPatch = {
  name?: string;
  description?: string | null;
  archived_at?: string | null;
  updated_at?: string;
};

export type NewNodeRecord = {
  project_id: number;
  type: NodeType;
  parent_id: number | null;
  seq: number;
  title: string;
  description: string | null;
  // task-only
  lifecycle?: Lifecycle;
  hold?: Hold;
  priority?: Priority | null;
  size?: Size | null;
  rank?: number | null;
  external_ref?: string | null;
  // phase-only
  target?: string | null;
};

/** The columns node mutations patch — identity (`project_id`, `type`, `seq`) is immutable. */
export type NodePatch = {
  title?: string;
  description?: string | null;
  parent_id?: number | null;
  lifecycle?: Lifecycle;
  hold?: Hold;
  hold_reason?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  rank?: number | null;
  external_ref?: string | null;
  completed_at?: string | null;
  target?: string | null;
  updated_at?: string;
};

export type NewAnnotationRecord = {
  node_id: number;
  content: string;
};

export type NewArtifactRecord = {
  project_id: number;
  seq: number;
  title: string;
  content: string;
};

/** `title` is an artifact's one mutable field — content stays frozen (ADR 0004). */
export type ArtifactPatch = {
  title?: string;
};

export type NewTagRecord = {
  entity_type: TagEntityType;
  entity_id: number;
  tag: string;
  note: string | null;
};

// Entity-keyed (ADR 0015): exactly one of node_id / project_id is set.
export type NewTransitionRecord = {
  kind: TransitionKind;
  node_id?: number | null;
  project_id?: number | null;
  from_value: string | null;
  to_value: string | null;
  reason?: string | null;
};

/** A ranked task's ordering row — `rank` asc, `seq` asc (the stable tiebreak). */
export type RankedTask = {
  id: number;
  rank: number;
  seq: number;
};

/**
 * The write scope (MMR-135): the storage vocabulary the verbs compose inside
 * one `transact` — point reads, allocation, and row-level writes. Primitives,
 * not verb-level operations; the behavioral invariants stay in the verbs.
 * Every method sees the transaction's own in-flight state.
 */
export type StoreWriter = {
  /** The in-scope bulk snapshot the mutation guards derive over. */
  loadWorkingSet: () => Promise<WorkingSet>;

  // Point reads
  loadNode: (id: number) => Promise<Node | undefined>;
  loadProject: (id: number) => Promise<Project | undefined>;
  loadProjectByKey: (key: string) => Promise<Project | undefined>;
  loadArtifact: (id: number) => Promise<Artifact | undefined>;
  /** Direct children of a node (one hop, not the subtree). */
  listChildren: (parentId: number) => Promise<number[]>;
  /** The nodes `nodeId` directly depends on (its outgoing `depends_on` edges). */
  listPrereqsOf: (nodeId: number) => Promise<number[]>;
  /** A project's ranked tasks (`rank` non-null), ordered `rank` asc then `seq` asc. */
  listRankedTasks: (projectId: number) => Promise<RankedTask[]>;

  // Allocation (ADR 0006) — the atomic per-project counter bumps.
  allocateSeq: (projectId: number) => Promise<number>;
  allocateArtifactSeq: (projectId: number) => Promise<number>;

  // Writes
  insertProject: (row: NewProjectRecord) => Promise<Project>;
  updateProject: (id: number, patch: ProjectPatch) => Promise<void>;
  insertNode: (row: NewNodeRecord) => Promise<Node>;
  updateNode: (id: number, patch: NodePatch) => Promise<void>;
  insertDependency: (edge: Dependency) => Promise<void>;
  /** Delete one edge; `true` iff a row was removed. */
  deleteDependency: (edge: Dependency) => Promise<boolean>;
  insertAnnotation: (row: NewAnnotationRecord) => Promise<void>;
  insertArtifact: (row: NewArtifactRecord) => Promise<{ id: number }>;
  updateArtifact: (id: number, patch: ArtifactPatch) => Promise<void>;
  linkArtifact: (artifactId: number, nodeId: number) => Promise<void>;
  /** Idempotent tag insert — an existing (entity, tag) row is kept untouched. */
  insertTag: (row: NewTagRecord) => Promise<void>;
  /** Tag insert that overwrites the stored note on conflict (the note rides the application). */
  upsertTagNote: (row: NewTagRecord & { note: string }) => Promise<void>;
  /** Remove the given tags from one entity; returns the number of rows deleted. */
  deleteTags: (entityType: TagEntityType, entityId: number, tags: string[]) => Promise<number>;
  appendTransition: (row: NewTransitionRecord) => Promise<void>;
};

export type Store = {
  /** The coarse bulk read every selection/derivation view starts from. */
  loadWorkingSet: () => Promise<WorkingSet>;

  /**
   * The write scope (MMR-135): run `fn` inside one transaction over the
   * `StoreWriter` vocabulary. A throw rolls the whole scope back — a verb's
   * invariant failure leaves no partial rows.
   */
  transact: <T>(fn: (w: StoreWriter) => Promise<T>) => Promise<T>;

  /**
   * The artifact slice (MMR-143, ADR 0016 Phase 2a) — the first surface with
   * two backends. The composition root plugs in SQLite (default) or the
   * Norn vault; everything artifact-shaped routes through here, keyed by
   * external identity, never numeric ids.
   */
  readonly artifacts: ArtifactStore;

  /**
   * Transitional (MMR-133): the raw executor, for core read paths not yet
   * behind the seam — point lookups, facet loads, and per-node derivation.
   * Shrinks with Phase 2a/2b (reads through the seam), then leaves the
   * interface.
   */
  readonly db: Db;
};
