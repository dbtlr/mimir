import type { Db } from './context';
import type { Dependency, Node, Project, Tag } from './model';

/**
 * The coarse storage seam (ADR 0016 Phase 0). The core reads work state as
 * bulk projections — O(views) store queries, never O(nodes) — and derives
 * everything else in memory. A backend implements this interface; SQLite is
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
};

export type Store = {
  /** The coarse bulk read every selection/derivation view starts from. */
  loadWorkingSet: () => Promise<WorkingSet>;

  /**
   * Transitional (MMR-133): the raw executor, for core paths not yet behind
   * the seam — point lookups, facet loads, per-node derivation, and the write
   * verbs. Shrinks with MMR-134 (pure in-memory derivation) and MMR-135
   * (writes through the seam), then leaves the interface.
   */
  readonly db: Db;
};
