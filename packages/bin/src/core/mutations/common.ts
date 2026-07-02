import type { NewTransitionRow } from '../../db/schema';
import type { Tx } from '../context';
import { deriveSet, lineageIds, renderNodeIdFromSet } from '../derive';
import { conflict, invariant, notFound, validation } from '../errors';
import { renderNodeId } from '../lookup';
import type { Node } from '../model';
import { isReady } from '../predicates';
import { loadWorkingSet } from '../store-sqlite';
import { now } from '../time';

/**
 * Shared machinery for the mutation verbs. Every status-bearing verb is one
 * transaction: load → validate the behavioral invariant → write the column(s)
 * → append a `transition_log` row → adjust rank → stamp `updated_at` → echo the
 * affected node (ADR 0003). These helpers are the reusable steps.
 */

/** Reload a node that must exist (post-write echo / mid-verb refresh). */
export async function reloadNode(tx: Tx, id: number): Promise<Node> {
  const node = await tx.selectFrom('node').selectAll().where('id', '=', id).executeTakeFirst();
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
export async function assertProjectActive(tx: Tx, projectId: number): Promise<void> {
  const project = await tx
    .selectFrom('project')
    .select(['key', 'archived_at'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (project?.archived_at != null) {
    throw conflict(
      `project ${project.key} is archived — no changes are allowed`,
      `unarchive it first: mimir unarchive ${project.key}`,
    );
  }
}

/**
 * Load a node by id, asserting it exists — and that its owning project is not
 * archived (the write-lock choke point, ADR 0015). Every node mutation loads
 * its target (and any reference node) through here, so the freeze can't be
 * bypassed per-verb.
 */
export async function requireNode(tx: Tx, id: number): Promise<Node> {
  const node = await tx.selectFrom('node').selectAll().where('id', '=', id).executeTakeFirst();
  if (node === undefined) {
    throw notFound('the record was not found');
  }
  await assertProjectActive(tx, node.project_id);
  return node;
}

/**
 * Collect ready descendant task ids under a container node, for actionable hints.
 * Walks all tasks in the same project, checks parent chain for containment, then
 * readiness (dependency settlement). Returns rendered ids like ["MMR-3", "MMR-4"].
 */
async function readyDescendantIds(tx: Tx, container: Node): Promise<string[]> {
  const set = deriveSet(await loadWorkingSet(tx));
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
    const rendered = renderNodeIdFromSet(set, task);
    if (rendered !== null) {
      ids.push(rendered);
    }
  }
  return ids;
}

/** Load a node, asserting it is a task (verbs that touch lifecycle/hold/rank). */
export async function requireTask(tx: Tx, id: number): Promise<Node> {
  const node = await requireNode(tx, id);
  if (node.type !== 'task') {
    const rendered = (await renderNodeId(tx, id)) ?? 'it';
    const article = node.type === 'initiative' ? 'an' : 'a';
    const readyIds = await readyDescendantIds(tx, node);
    const hint =
      readyIds.length > 0
        ? `containers aren't started directly — start a ready task under it: ${readyIds.join(', ')}`
        : `containers aren't started directly — no ready tasks under it; see its shape with 'mimir tree ${rendered}'`;
    throw validation(`${rendered} is ${article} ${node.type}, not a task`, hint);
  }
  return node;
}

/** Stamp `updated_at` on a node — the core is the sole time-maintainer (not a trigger). */
export async function stamp(tx: Tx, id: number): Promise<void> {
  await tx.updateTable('node').set({ updated_at: now() }).where('id', '=', id).execute();
}

/** Append a transition-log row in the verb's own transaction (so columns + log can't drift). */
export async function logTransition(tx: Tx, row: NewTransitionRow): Promise<void> {
  await tx.insertInto('transition_log').values(row).execute();
}
