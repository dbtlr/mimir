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
import type { BodySectionStore } from './body-sections/store';
import type { Artifact, Dependency, Node, Project } from './model';
import type { SeedStore } from './seeds/store';
import type { TransitionsFeed } from './transitions/store';

/**
 * The coarse storage seam (ADR 0016 Phase 0). The core reads work state as
 * bulk projections — O(views) store queries, never O(nodes) — and derives
 * everything else in memory; writes run inside `transact`, composing the
 * `StoreWriter` primitives. The Norn markdown vault implements this interface
 * (`createNornWriteStore`, ADR 0016) — the sole backend since MMR-234.
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
export type NodeTag = { tag: string; created_at: string };

export type WorkingSet = {
  /** Every project, key-ordered, archived included. */
  projects: readonly Project[];
  nodes: readonly Node[];
  edges: readonly Dependency[];
  /** Node stem → its tag records in `created_at` order. Absent = untagged. */
  nodeTags: ReadonlyMap<string, readonly NodeTag[]>;
  /** Project key → its tag records in `created_at` order. Absent = untagged. */
  projectTags: ReadonlyMap<string, readonly NodeTag[]>;
  /** How many records the tolerant reader dropped/noted (ADR 0017) while
   * building this set — the shared `validate()` pass's `dropped.length`,
   * carried as a byproduct of the load itself (MMR-184). Optional: only the
   * Norn-backed `Store.loadWorkingSet` populates it; the write path's
   * in-transaction overlay (`StoreWriter.loadWorkingSet`) omits it — a
   * transact never re-validates, so it has no fresher count to offer. */
  issueCount?: number;
};

// ---------------------------------------------------------------------------
// Write records — the backend-neutral shapes the verbs hand the writer.
// Patterned like `model.ts` (snake_case store vocabulary) — the store maps them
// onto the vault's frontmatter.
// ---------------------------------------------------------------------------

export type NewProjectRecord = {
  key: string;
  name: string;
  description: string | null;
  tags?: string[];
};

/** The mutable project columns — `key` and the counters are immutable/allocated. */
export type ProjectPatch = {
  name?: string;
  description?: string | null;
  archived_at?: string | null;
  updated_at?: string;
};

export type NewNodeRecord = {
  project_id: string;
  type: NodeType;
  parent_id: string | null;
  tags?: string[];
  title: string;
  description: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  // task-only
  lifecycle?: Lifecycle;
  hold?: Hold;
  priority?: Priority | null;
  size?: Size | null;
  rank?: number | null;
  external_ref?: string | null;
  /** The requester-side seed pointer (`KEY-sN`), nullable (MMR-244). */
  upstream?: string | null;
  // phase-only
  target?: string | null;
  // container-only (phase/initiative) — MMR-204
  open_ended?: boolean | null;
};

/** The columns node mutations patch — identity (`project_id`, `type`, `seq`) is immutable. */
export type NodePatch = {
  title?: string;
  description?: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  parent_id?: string | null;
  lifecycle?: Lifecycle;
  hold?: Hold;
  hold_reason?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  rank?: number | null;
  external_ref?: string | null;
  /** The requester-side seed pointer (`KEY-sN`), nullable (MMR-244). */
  upstream?: string | null;
  completed_at?: string | null;
  target?: string | null;
  // container-only (phase/initiative) — MMR-204
  open_ended?: boolean | null;
  updated_at?: string;
};

export type NewAnnotationRecord = {
  node_id: string;
  content: string;
  // Core-supplied (MMR-173): the mutation layer stamps this, not a store-side
  // default, so every `Store` port implementor persists the identical value
  // (ADR 0016 Refinement, MMR-279) — the `stamp` invariant (the core is the
  // sole time-maintainer) now holds for annotations too.
  created_at: string;
};

export type NewArtifactRecord = {
  project_id: string;
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
  entity_id: string;
  tag: string;
};

// Entity-keyed (ADR 0015): exactly one of node_id / project_id is set.
export type NewTransitionRecord = {
  kind: TransitionKind;
  node_id?: string | null;
  project_id?: string | null;
  from_value: string | null;
  to_value: string | null;
  reason?: string | null;
  // Core-supplied (MMR-173): stamped by `logTransition`, not the store, so the
  // transition time upholds the `stamp` invariant (the core is the sole
  // time-maintainer).
  at: string;
};

/** A ranked task's ordering row — `rank` asc, `seq` asc (the stable tiebreak). */
export type RankedTask = {
  id: string;
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
  /** Whether the durable snapshot contains more than one physical doc for this identity. */
  hasIdentityCollision: (stem: string) => Promise<boolean>;

  // Point reads
  loadNode: (id: string) => Promise<Node | undefined>;
  loadProject: (key: string) => Promise<Project | undefined>;
  loadArtifact: (id: string) => Promise<Artifact | undefined>;
  /** Direct children of a node (one hop, not the subtree). */
  listChildren: (parentId: string) => Promise<string[]>;
  /** The nodes `nodeId` directly depends on (its outgoing `depends_on` edges). */
  listPrereqsOf: (nodeId: string) => Promise<string[]>;
  /** A project's ranked tasks (`rank` non-null), ordered `rank` asc then `seq` asc. */
  listRankedTasks: (projectId: string) => Promise<RankedTask[]>;

  // Allocation (ADR 0006) — the atomic per-project counter bumps.
  allocateArtifactSeq: (projectId: string) => Promise<number>;

  // Writes
  insertProject: (row: NewProjectRecord) => Promise<Project>;
  updateProject: (key: string, patch: ProjectPatch) => Promise<void>;
  insertNode: (row: NewNodeRecord) => Promise<Node>;
  updateNode: (id: string, patch: NodePatch) => Promise<void>;
  insertDependency: (edge: Dependency) => Promise<void>;
  /** Delete one edge; `true` iff a row was removed. */
  deleteDependency: (edge: Dependency) => Promise<boolean>;
  insertAnnotation: (row: NewAnnotationRecord) => Promise<void>;
  insertArtifact: (row: NewArtifactRecord) => Promise<{ id: string }>;
  updateArtifact: (id: string, patch: ArtifactPatch) => Promise<void>;
  linkArtifact: (artifactId: string, nodeId: string) => Promise<void>;
  /** Idempotent tag insert — an existing (entity, tag) row is kept untouched. */
  insertTag: (row: NewTagRecord) => Promise<void>;
  /** Remove the given tags from one entity; returns the number of rows deleted. */
  deleteTags: (entityType: TagEntityType, entityId: string, tags: string[]) => Promise<number>;
  appendTransition: (row: NewTransitionRecord) => Promise<void>;
};

export type Store = {
  /** The coarse bulk read every selection/derivation view starts from. */
  loadWorkingSet: () => Promise<WorkingSet>;

  /**
   * The lightweight all-projects read (MMR-251): every project (archived included),
   * WITHOUT the whole-vault node load. The seed resolving seam's requester/board
   * view — an unknown/archived requester nulls, an archived own-board freezes — needs
   * only project keys and their `archived_at`, so this is the projects-only slice of
   * {@link loadWorkingSet}.
   */
  loadProjects: () => Promise<readonly Project[]>;

  /**
   * The project-scoped node read (MMR-251): the nodes of the named projects only,
   * validated identically to {@link loadWorkingSet} (a bad or duplicate node is
   * dropped). The seed resolving seam's spawned-target settledness closure —
   * settledness is a task's own lifecycle or a container's descendant rollup, and
   * every Mimir-written lineage is in-project (creates pin directory + frontmatter
   * together; moves are within-project) — so for Mimir-written state, loading the
   * targets' projects is the whole closure without a whole-vault load. Hand-edited
   * cross-project topology (a parent or frontmatter `project` pointing outside the
   * loaded slice) is NOT retrievable here: the validator drops the foreign edge,
   * which can read differently than the whole-vault path until `mimir doctor`
   * surfaces and the operator repairs it — the accepted corruption posture
   * (ADR 0023: reads degrade fail-closed; doctor remediates, reads don't guess).
   * Edges are not projected (settledness never consults them). An empty key list
   * reads as no nodes (no query).
   *
   * `validProjectKeys` is the caller's already-validated project-key set (from
   * {@link loadProjects}): presence is derived from it, NOT trusted from the requested
   * keys, so a target in a missing/duplicate-key project drops identically to the
   * whole-vault path (MMR-251).
   */
  loadNodesForProjects: (
    projectKeys: readonly string[],
    validProjectKeys: ReadonlySet<string>,
  ) => Promise<readonly Node[]>;

  /**
   * The write scope (MMR-135): run `fn` inside one transaction over the
   * `StoreWriter` vocabulary. A throw rolls the whole scope back — a verb's
   * invariant failure leaves no partial rows.
   */
  transact: <T>(fn: (w: StoreWriter) => Promise<T>) => Promise<T>;

  /**
   * The artifact slice (MMR-143, ADR 0016 Phase 2a) — everything artifact-shaped
   * routes through here, keyed by canonical artifact stem (`KEY-aN`).
   */
  readonly artifacts: ArtifactStore;

  /**
   * The seed slice (MMR-244) — the grooming-queue entity, project-anchored like
   * artifacts (ADR 0004 precedent), keyed by the `KEY-sN` external identity.
   */
  readonly seeds: SeedStore;

  /**
   * The body-section read slice (MMR-154, ADR 0016 Phase 3) — a node's
   * `## History` and `## Annotations` facets, backed by the markdown body
   * sections in the vault.
   */
  readonly bodySections: BodySectionStore;

  /**
   * The cross-node transition feed slice (MMR-160, ADR 0016 Phase 3) — the
   * whole-portfolio transition log, backed by the fanned-out `## History`
   * sections in the vault.
   */
  readonly transitions: TransitionsFeed;
};
