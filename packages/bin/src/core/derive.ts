import type { StatusWord } from '@mimir/contract';

import { MimirError, invariant } from './errors';
import { parseId } from './ids';
import type { Node, Project } from './model';
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
  readonly nodeById: ReadonlyMap<string, Node>;
  readonly childrenByParent: ReadonlyMap<string, readonly Node[]>;
  readonly nodesByProject: ReadonlyMap<string, readonly Node[]>;
  /** node id → its own prerequisite node ids (`depends_on`). */
  readonly prereqsByNode: ReadonlyMap<string, readonly string[]>;
  /** node id → the node ids that depend on it. */
  readonly dependentsByNode: ReadonlyMap<string, readonly string[]>;
  /** Archived project ids — their nodes read as absent / settled (ADR 0015). */
  readonly archivedProjects: ReadonlySet<string>;
  /** Per-snapshot memo + recursion guard — internal to this module. */
  readonly memo: Map<string, StatusWord>;
  /** Per-snapshot memo for the *raw* container word (pre open-ended coercion) —
   * feeds the transparency test without paying the child walk twice (MMR-204). */
  readonly rawMemo: Map<string, StatusWord>;
  readonly inFlight: Set<string>;
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
  const childrenByParent = new Map<string, Node[]>();
  const nodesByProject = new Map<string, Node[]>();
  for (const node of ws.nodes) {
    if (node.parent_id !== null) {
      push(childrenByParent, node.parent_id, node);
    }
    push(nodesByProject, node.project_id, node);
  }
  const prereqsByNode = new Map<string, string[]>();
  const dependentsByNode = new Map<string, string[]>();
  for (const edge of ws.edges) {
    push(prereqsByNode, edge.node_id, edge.depends_on_node_id);
    push(dependentsByNode, edge.depends_on_node_id, edge.node_id);
  }
  // Preserve numeric node ordering even though identity is the canonical stem.
  for (const list of prereqsByNode.values()) {
    list.sort(compareNodeIds);
  }
  return {
    archivedProjects: new Set(ws.projects.filter((p) => p.archived_at !== null).map((p) => p.key)),
    childrenByParent,
    dependentsByNode,
    inFlight: new Set(),
    memo: new Map(),
    nodeById: new Map(ws.nodes.map((n) => [n.id, n])),
    nodesByProject,
    prereqsByNode,
    rawMemo: new Map(),
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
  constructor(nodeId: string) {
    super('invariant', `derivation cycle through container dependencies at node ${nodeId}`);
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
function nodeHitsDerivationCycle(ws: WorkingSet, nodeId: string): boolean {
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
  nodeId: string,
): boolean {
  return nodeHitsDerivationCycle(after, nodeId) && !nodeHitsDerivationCycle(before, nodeId);
}

/**
 * Resolve an external `KEY-seq` id to its node against the working-set
 * snapshot (ADR 0016 Phase 2b). Returns `undefined` for a malformed id or an
 * unknown key/seq; a node in an archived project still resolves (the caller
 * applies the hiding).
 */
export function findNodeInSet(set: DerivationSet, id: string): Node | undefined {
  return parseId(id) === null ? undefined : set.nodeById.get(id);
}

/** Resolve a project `KEY` to its Project against the working-set snapshot — the
 * in-memory twin of a `project`-by-key row read; `undefined` for an unknown key.
 * The by-key sibling of {@link findNodeInSet}. */
export function findProjectInSet(set: DerivationSet, key: string): Project | undefined {
  return set.ws.projects.find((p) => p.key === key);
}

/** Terminal = a decided end state. `abandoned` counts as terminal (and never freezes a parent). */
export function isTerminalWord(word: StatusWord): boolean {
  return word === 'done' || word === 'abandoned';
}

/** Idle = no live work under the node: an all-terminal rollup, or empty (`new`). */
function isIdleWord(word: StatusWord): boolean {
  return isTerminalWord(word) || word === 'new';
}

/**
 * A container's *raw* rollup word — `interpret` over its contributing children,
 * **before** the open-ended coercion {@link nodeStatusWord} applies. The
 * transparency test needs the uncoerced word (an idle open-ended container reads
 * `ready`, which would otherwise look live), so it is memoized separately. Tasks
 * have no rollup — callers only pass containers. (MMR-204)
 */
function rawContainerWord(set: DerivationSet, node: Node): StatusWord {
  const cached = set.rawMemo.get(node.id);
  if (cached !== undefined) {
    return cached;
  }
  const raw = interpret(childDistribution(set, node.id));
  set.rawMemo.set(node.id, raw);
  return raw;
}

/**
 * A "transparent" container (MMR-204): an open-ended phase/initiative with no
 * live children (idle rollup or empty). It drops out of its parent's rollup
 * distribution entirely, so a standing home (Bugs, Polish, Ideas) never strands
 * a normal ancestor from auto-closing. With live children it is not transparent
 * and tallies its word normally.
 */
function isTransparentOpenEnded(set: DerivationSet, node: Node): boolean {
  return (
    node.type !== 'task' && node.open_ended === true && isIdleWord(rawContainerWord(set, node))
  );
}

/**
 * Is a node "settled" for dependency purposes — i.e. it no longer holds up work
 * that depends on it? A task is settled iff its lifecycle is terminal; a
 * non-leaf iff its **derived word** is terminal.
 *
 * A dependency is satisfied when its prerequisite is **terminal**, so an
 * *abandoned* prerequisite satisfies (it no longer blocks), consistent with
 * "abandoned never freezes." ADR 0001's original shorthand was "all deps done";
 * refined (2026-06-05) to "all deps settled" so an abandoned prerequisite does
 * not strand its dependent forever — see ADR 0001 § "Refinement — dependency
 * satisfaction is terminal, not done."
 *
 * The container branch routes through {@link nodeStatusWord} (not the raw
 * `interpret`) so settledness tracks the *displayed* word: an **open-ended**
 * container's word is never terminal (MMR-204), so a standing home never
 * satisfies a dependency — the honest reading, matching the non-terminal `ready`
 * it shows rather than the all-terminal rollup underneath. For a normal container
 * the two are identical.
 */
export function isNodeSettled(
  set: DerivationSet,
  node: Pick<Node, 'id' | 'type' | 'lifecycle'>,
): boolean {
  if (node.type === 'task') {
    return node.lifecycle === 'done' || node.lifecycle === 'abandoned';
  }
  const full = set.nodeById.get(node.id);
  return full !== undefined && isTerminalWord(nodeStatusWord(set, full));
}

/** A node and all of its ancestors (walking `parent_id` to the root). */
export function lineageIds(set: DerivationSet, nodeId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = nodeId;
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
export function hasUnsettledPrereq(set: DerivationSet, taskId: string): boolean {
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
        throw invariant(`${node.id} is missing a status axis`);
      }
      const awaiting = hasUnsettledPrereq(set, node.id);
      word = taskStatus({ awaiting, hold: node.hold, lifecycle: node.lifecycle });
    } else {
      // Open-ended (MMR-204): a *transparent* container (idle open-ended) reads
      // `ready` ("open for filing") — the very condition that also drops it from a
      // parent's rollup, single-sourced through `isTransparentOpenEnded`. A live or
      // normal container passes its raw rollup word through unchanged.
      word = isTransparentOpenEnded(set, node) ? 'ready' : rawContainerWord(set, node);
    }
    set.memo.set(node.id, word);
    return word;
  } finally {
    set.inFlight.delete(node.id);
  }
}

/**
 * The rollup distribution over a node's **direct** children (their Status words
 * tallied). A transparent open-ended child (idle standing container) is excluded
 * entirely, so it can't keep its parent from auto-closing (MMR-204).
 */
export function childDistribution(set: DerivationSet, nodeId: string): Distribution {
  const children = set.childrenByParent.get(nodeId) ?? [];
  const contributing = children.filter((child) => !isTransparentOpenEnded(set, child));
  return tally(contributing.map((child) => nodeStatusWord(set, child)));
}

/**
 * The status tally over a project's **leaf tasks** — every `type = "task"` node
 * in the project (any depth), its derived status word counted (MMR-105). The
 * leaf-level sibling of {@link childDistribution} (direct children) and
 * {@link rootDistribution} (project roots); backs the project card's vitals panel.
 */
export function leafDistribution(set: DerivationSet, projectId: string): Distribution {
  const tasks = (set.nodesByProject.get(projectId) ?? []).filter((n) => n.type === 'task');
  return tally(tasks.map((task) => nodeStatusWord(set, task)));
}

/** The rollup distribution over a project's **root** nodes (the cascade's top
 * step, MMR-32). A transparent open-ended root is excluded, mirroring
 * {@link childDistribution} — a standing root never strands the project (MMR-204). */
export function rootDistribution(set: DerivationSet, projectId: string): Distribution {
  const roots = (set.nodesByProject.get(projectId) ?? []).filter(
    (n) => n.parent_id === null && !isTransparentOpenEnded(set, n),
  );
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
  // `status` routes through nodeStatusWord so the open-ended coercion (MMR-204)
  // applies; `distribution` is the contributing-children tally (the "why").
  return { distribution: childDistribution(set, node.id), status: nodeStatusWord(set, node) };
}

/** `status_of` for a whole project — `interpret` over its root nodes. */
export function statusOfProject(
  set: DerivationSet,
  projectId: string,
): { status: StatusWord; distribution: Distribution } {
  const distribution = rootDistribution(set, projectId);
  return { distribution, status: interpret(distribution) };
}

function compareNodeIds(a: string, b: string): number {
  const left = parseId(a);
  const right = parseId(b);
  if (left === null || right === null || left.key !== right.key) {
    return a.localeCompare(b);
  }
  return left.seq - right.seq;
}
