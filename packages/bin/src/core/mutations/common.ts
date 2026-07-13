import { deriveSet, lineageIds } from '../derive';
import { conflict, invariant, notFound, validation } from '../errors';
import type { Node } from '../model';
import { isReady } from '../predicates';
import type { NewTransitionRecord, StoreWriter } from '../store';
import { now } from '../time';

/**
 * Shared machinery for the mutation verbs. Every status-bearing verb is one
 * `transact` scope: load → validate the behavioral invariant → write the
 * column(s) → append a `transition_log` row → adjust rank → stamp `updated_at`
 * → echo the affected node (ADR 0003). These helpers are the reusable steps,
 * composed over the writer so they see in-tx state.
 */

/** Reload a node that must exist (post-write echo / mid-verb refresh). */
export async function reloadNode(w: StoreWriter, id: string): Promise<Node> {
  const node = await w.loadNode(id);
  if (node === undefined) {
    throw invariant('the record vanished mid-transaction');
  }
  return node;
}

/**
 * The archive write-lock (ADR 0015): reject a mutation whose owning project is
 * archived. This is the core-side guarantee that a frozen project accepts no
 * changes through *any* transport. `requireNode` bakes it in for every
 * node-targeting verb; the handful of project-level / create / attach / tag
 * paths that don't load a node first call it directly with the owning project.
 */
export async function assertProjectActive(w: StoreWriter, projectId: string): Promise<void> {
  const project = await w.loadProject(projectId);
  if (project?.archived_at != null) {
    throw conflict(
      `project ${project.key} is archived — no changes are allowed`,
      `unarchive it first: mimir unarchive ${project.key}`,
    );
  }
}

/**
 * Render a node's external `KEY-seq` id from two writer point reads — the
 * in-scope equivalent of `lookup.renderNodeId` for verb hints and log values.
 */
export async function renderNodeRef(w: StoreWriter, nodeId: string): Promise<string | null> {
  const node = await w.loadNode(nodeId);
  if (node === undefined) {
    return null;
  }
  return node.id;
}

/**
 * Load a node by id, asserting it exists — and that its owning project is not
 * archived (the write-lock choke point, ADR 0015). Every node mutation loads
 * its target (and any reference node) through here, so the freeze can't be
 * bypassed per-verb.
 */
export async function requireNode(w: StoreWriter, id: string): Promise<Node> {
  const node = await w.loadNode(id);
  if (node === undefined) {
    throw notFound('the record was not found');
  }
  await assertProjectActive(w, node.project_id);
  return node;
}

/**
 * Collect ready descendant task ids under a container node, for actionable hints.
 * Walks all tasks in the same project, checks parent chain for containment, then
 * readiness (dependency settlement). Returns rendered ids like ["MMR-3", "MMR-4"].
 */
async function readyDescendantIds(w: StoreWriter, container: Node): Promise<string[]> {
  const set = deriveSet(await w.loadWorkingSet());
  const candidates = (set.nodesByProject.get(container.project_id) ?? []).filter(
    (n) => n.type === 'task' && n.lifecycle === 'todo' && n.hold === 'none' && n.rank !== null,
  );
  const ids: string[] = [];
  for (const task of candidates) {
    // lineage is task-first, so containment = the container appears among ancestors.
    if (!lineageIds(set, task.id).includes(container.id)) {
      continue;
    }
    if (!isReady(set, task)) {
      continue;
    }
    ids.push(task.id);
  }
  return ids;
}

/** Load a node, asserting it is a task (verbs that touch lifecycle/hold/rank). */
export async function requireTask(w: StoreWriter, id: string): Promise<Node> {
  const node = await requireNode(w, id);
  if (node.type !== 'task') {
    const rendered = (await renderNodeRef(w, id)) ?? 'it';
    const article = node.type === 'initiative' ? 'an' : 'a';
    const readyIds = await readyDescendantIds(w, node);
    const hint =
      readyIds.length > 0
        ? `containers aren't started directly — start a ready task under it: ${readyIds.join(', ')}`
        : `containers aren't started directly — no ready tasks under it; see its shape with 'mimir tree ${rendered}'`;
    throw validation(`${rendered} is ${article} ${node.type}, not a task`, hint);
  }
  return node;
}

/** Stamp `updated_at` on a node — the core is the sole time-maintainer (not a trigger). */
export async function stamp(w: StoreWriter, id: string): Promise<void> {
  await w.updateNode(id, { updated_at: now() });
}

/**
 * Append a transition-log row in the verb's own write scope (so columns + log
 * can't drift). The transition `at` is stamped here — the single choke point
 * every status-bearing verb funnels through — so the core, not a per-backend DB
 * default, owns the time (MMR-173); both stores persist the value verbatim.
 */
export async function logTransition(
  w: StoreWriter,
  row: Omit<NewTransitionRecord, 'at'>,
): Promise<void> {
  await w.appendTransition({ ...row, at: now() });
}
