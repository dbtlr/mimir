import type { StatusWord } from '@mimir/contract';

import { MimirError, invariant } from './errors';
import { parseId, renderId } from './ids';
import type { Node } from './model';
import { interpret, tally, taskStatus } from './status';
import type { Distribution } from './status';
import type { WorkingSet } from './store';

/**
 * The live-derivation layer: a node's Status word, the rollup distribution, and
 * the completeness notion the dependency predicates rest on. Everything here is
 * computed on read — never stored (the spine; ADR 0001/0008) — as **pure
 * functions over one working-set snapshot** (ADR 0016 Phase 0): callers load
 * the set once per view and derive in memory, never per-node queries.
 */

/**
 * A working set indexed for derivation, with a per-snapshot status-word memo —
 * the set is an immutable snapshot, so each node's word is computed once and
 * whole-board derivation is O(N). Build one per view via {@link deriveSet};
 * after a mutation, derive from a fresh set.
 */
export type DerivationSet = {
  readonly ws: WorkingSet;
  readonly nodeById: ReadonlyMap<number, Node>;
  readonly childrenByParent: ReadonlyMap<number, readonly Node[]>;
  readonly nodesByProject: ReadonlyMap<number, readonly Node[]>;
  /** node id → its own prerequisite node ids (`depends_on`). */
  readonly prereqsByNode: ReadonlyMap<number, readonly number[]>;
  /** node id → the node ids that depend on it. */
  readonly dependentsByNode: ReadonlyMap<number, readonly number[]>;
  readonly keyByProjectId: ReadonlyMap<number, string>;
  /** Archived project ids — their nodes read as absent / settled (ADR 0015). */
  readonly archivedProjects: ReadonlySet<number>;
  /** Per-snapshot memo + recursion guard — internal to this module. */
  readonly memo: Map<number, StatusWord>;
  readonly inFlight: Set<number>;
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

/** Index a working set for derivation. */
export function deriveSet(ws: WorkingSet): DerivationSet {
  const childrenByParent = new Map<number, Node[]>();
  const nodesByProject = new Map<number, Node[]>();
  for (const node of ws.nodes) {
    if (node.parent_id !== null) {
      push(childrenByParent, node.parent_id, node);
    }
    push(nodesByProject, node.project_id, node);
  }
  const prereqsByNode = new Map<number, number[]>();
  const dependentsByNode = new Map<number, number[]>();
  for (const edge of ws.edges) {
    push(prereqsByNode, edge.node_id, edge.depends_on_node_id);
    push(dependentsByNode, edge.depends_on_node_id, edge.node_id);
  }
  // Prereq lists ascend by id — parity with the SQL path, whose per-node reads
  // came off the (node_id, depends_on_node_id) primary-key index. Dependents
  // stay in scan (rowid) order, matching the non-unique reverse index.
  for (const list of prereqsByNode.values()) {
    list.sort((a, b) => a - b);
  }
  return {
    archivedProjects: new Set(ws.projects.filter((p) => p.archived_at !== null).map((p) => p.id)),
    childrenByParent,
    dependentsByNode,
    inFlight: new Set(),
    keyByProjectId: new Map(ws.projects.map((p) => [p.id, p.key])),
    memo: new Map(),
    nodeById: new Map(ws.nodes.map((n) => [n.id, n])),
    nodesByProject,
    prereqsByNode,
    ws,
  };
}

/**
 * The derivation-cycle invariant: container dependencies can close a loop the
 * same-lineage and dependency-cycle guards don't see (a task awaiting a
 * container whose rollup depends back on the task's own container). Reads
 * surface it as a diagnosable `invariant`; the depend/move guards catch it by
 * type to reject the write that would close the loop (MMR-140).
 */
export class DerivationCycleError extends MimirError {
  constructor(nodeId: number) {
    super('invariant', `derivation cycle through container dependencies at node ${String(nodeId)}`);
    this.name = 'DerivationCycleError';
  }
}

/**
 * Does deriving `nodeId`'s word over this snapshot hit a container-dependency
 * cycle? Archived projects are treated as **live** here: the read path skips an
 * archived prerequisite (ADR 0015 Refinement), so a loop threaded through an
 * archived container would lie dormant and detonate on unarchive — prevention
 * counts it as real.
 */
function nodeHitsDerivationCycle(ws: WorkingSet, nodeId: number): boolean {
  const set = deriveSet({
    ...ws,
    projects: ws.projects.map((p) => (p.archived_at === null ? p : { ...p, archived_at: null })),
  });
  const node = set.nodeById.get(nodeId);
  if (node === undefined) {
    return false;
  }
  try {
    nodeStatusWord(set, node);
    return false;
  } catch (error) {
    if (error instanceof DerivationCycleError) {
      return true;
    }
    throw error;
  }
}

/**
 * Would applying a write turn `nodeId`'s word underivable with a
 * container-dependency cycle? The depend/move guards call this with the
 * snapshot as loaded (`before`) and with the candidate edge or re-parent
 * applied (`after`), so prevention reuses the exact runtime detection in
 * {@link nodeStatusWord} — no parallel graph walk to drift.
 *
 * Only the written node's word is derived: any cycle the write introduces
 * passes through it (a new edge gates the dependent's own subtree; a re-parent
 * rewires only the moved subtree's lineage), so the traversal stays local to
 * the affected subgraph. The `before` baseline keeps a pre-existing cycle in
 * legacy data from rejecting writes that don't make anything worse.
 */
export function writeIntroducesDerivationCycle(
  before: WorkingSet,
  after: WorkingSet,
  nodeId: number,
): boolean {
  return nodeHitsDerivationCycle(after, nodeId) && !nodeHitsDerivationCycle(before, nodeId);
}

/** Render a node's external `KEY-seq` id from the set (error messages, refs). */
export function renderNodeIdFromSet(set: DerivationSet, node: Node): string | null {
  const key = set.keyByProjectId.get(node.project_id);
  return key === undefined ? null : renderId({ key, seq: node.seq });
}

/**
 * Resolve an external `KEY-seq` id to its node against the working-set snapshot —
 * the in-memory twin of the SQL `findNodeByRef` (ADR 0016 Phase 2b). Returns
 * `undefined` for a malformed id or an unknown key/seq; a node in an archived
 * project still resolves (the caller applies the hiding), matching the SQL path.
 */
export function findNodeInSet(set: DerivationSet, id: string): Node | undefined {
  const ref = parseId(id);
  if (ref === null) {
    return undefined;
  }
  const project = set.ws.projects.find((p) => p.key === ref.key);
  if (project === undefined) {
    return undefined;
  }
  return set.ws.nodes.find((n) => n.project_id === project.id && n.seq === ref.seq);
}

/** Terminal = a decided end state. `abandoned` counts as terminal (and never freezes a parent). */
export function isTerminalWord(word: StatusWord): boolean {
  return word === 'done' || word === 'abandoned';
}

/**
 * Is a node "settled" for dependency purposes — i.e. it no longer holds up work
 * that depends on it? A task is settled iff its lifecycle is terminal; a
 * non-leaf iff its rollup is terminal.
 *
 * A dependency is satisfied when its prerequisite is **terminal**, so an
 * *abandoned* prerequisite satisfies (it no longer blocks), consistent with
 * "abandoned never freezes." ADR 0001's original shorthand was "all deps done";
 * refined (2026-06-05) to "all deps settled" so an abandoned prerequisite does
 * not strand its dependent forever — see ADR 0001 § "Refinement — dependency
 * satisfaction is terminal, not done."
 */
export function isNodeSettled(
  set: DerivationSet,
  node: Pick<Node, 'id' | 'type' | 'lifecycle'>,
): boolean {
  if (node.type === 'task') {
    return node.lifecycle === 'done' || node.lifecycle === 'abandoned';
  }
  return isTerminalWord(interpret(childDistribution(set, node.id)));
}

/** A node and all of its ancestors (walking `parent_id` to the root). */
export function lineageIds(set: DerivationSet, nodeId: number): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  let cur: number | null = nodeId;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    ids.push(cur);
    cur = set.nodeById.get(cur)?.parent_id ?? null;
  }
  return ids;
}

/**
 * Does this task have ≥1 unsettled **effective** prerequisite — its own edges
 * *or any inherited from an ancestor* (ADR 0001 Refinement)? A dependency
 * declared on a container gates every descendant, so the dependent's actionable
 * set is computed over the lineage's edges, not just the node's own.
 */
export function hasUnsettledPrereq(set: DerivationSet, taskId: number): boolean {
  for (const ancestorId of lineageIds(set, taskId)) {
    for (const prereqId of set.prereqsByNode.get(ancestorId) ?? []) {
      const prereq = set.nodeById.get(prereqId);
      if (prereq === undefined) {
        continue;
      }
      // A prereq in an archived project counts as settled — archiving is a
      // stronger "this is over" than abandoning, so it no longer gates downstream
      // work (ADR 0015 Refinement). Without this, a live task depending into a
      // newly-archived project would await a frozen, hidden prerequisite forever.
      if (set.archivedProjects.has(prereq.project_id)) {
        continue;
      }
      if (!isNodeSettled(set, prereq)) {
        return true;
      }
    }
  }
  return false;
}

/** Project any node to its Status word (ADR 0008): a task via its axes + readiness, a non-leaf via `interpret`. */
export function nodeStatusWord(set: DerivationSet, node: Node): StatusWord {
  const cached = set.memo.get(node.id);
  if (cached !== undefined) {
    return cached;
  }
  if (set.inFlight.has(node.id)) {
    // The old per-node query path recursed forever on this shape; the guard
    // makes it a diagnosable error (see DerivationCycleError).
    throw new DerivationCycleError(node.id);
  }
  set.inFlight.add(node.id);
  try {
    let word: StatusWord;
    if (node.type === 'task') {
      if (node.lifecycle === null || node.hold === null) {
        const rendered = renderNodeIdFromSet(set, node) ?? 'task';
        throw invariant(`${rendered} is missing a status axis`);
      }
      const awaiting = hasUnsettledPrereq(set, node.id);
      word = taskStatus({ awaiting, hold: node.hold, lifecycle: node.lifecycle });
    } else {
      word = interpret(childDistribution(set, node.id));
    }
    set.memo.set(node.id, word);
    return word;
  } finally {
    set.inFlight.delete(node.id);
  }
}

/** The rollup distribution over a node's **direct** children (their Status words tallied). */
export function childDistribution(set: DerivationSet, nodeId: number): Distribution {
  const children = set.childrenByParent.get(nodeId) ?? [];
  return tally(children.map((child) => nodeStatusWord(set, child)));
}

/**
 * The status tally over a project's **leaf tasks** — every `type = "task"` node
 * in the project (any depth), its derived status word counted (MMR-105). The
 * leaf-level sibling of {@link childDistribution} (direct children) and
 * {@link rootDistribution} (project roots); backs the project card's vitals panel.
 */
export function leafDistribution(set: DerivationSet, projectId: number): Distribution {
  const tasks = (set.nodesByProject.get(projectId) ?? []).filter((n) => n.type === 'task');
  return tally(tasks.map((task) => nodeStatusWord(set, task)));
}

/** The rollup distribution over a project's **root** nodes (the cascade's top step, MMR-32). */
export function rootDistribution(set: DerivationSet, projectId: number): Distribution {
  const roots = (set.nodesByProject.get(projectId) ?? []).filter((n) => n.parent_id === null);
  return tally(roots.map((root) => nodeStatusWord(set, root)));
}

/** `status_of` — a node's distribution and its single `interpret` label together (label = what, distribution = why). */
export function statusOf(
  set: DerivationSet,
  node: Node,
): { status: StatusWord; distribution: Distribution } {
  if (node.type === 'task') {
    return { distribution: {}, status: nodeStatusWord(set, node) };
  }
  const distribution = childDistribution(set, node.id);
  return { distribution, status: interpret(distribution) };
}

/** `status_of` for a whole project — `interpret` over its root nodes. */
export function statusOfProject(
  set: DerivationSet,
  projectId: number,
): { status: StatusWord; distribution: Distribution } {
  const distribution = rootDistribution(set, projectId);
  return { distribution, status: interpret(distribution) };
}
