import type { Db, Tx } from '../context';
import { isNodeSettled, lineageIds } from '../derive';
import { conflict, notFound } from '../errors';
import { renderNodeId } from '../lookup';
import type { Project } from '../model';
import { isReady } from '../predicates';
import { now } from '../time';
import { logTransition } from './common';

/**
 * Project archive (ADR 0015). Archiving sets `project.archived_at` and freezes
 * the whole subtree (the write-lock lives in `requireNode` /
 * `assertProjectActive`); unarchiving clears it. Both are reversible,
 * reason-bearing transitions logged against the **project** (the entity-keyed
 * `transition_log`) — never a delete, so append-only holds.
 */

async function loadProject(tx: Tx, id: number): Promise<Project> {
  const project = await tx
    .selectFrom('project')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (project === undefined) {
    throw notFound('the project was not found');
  }
  return project;
}

/** Archive a project (active → archived). Idempotency is a conflict, not a no-op. */
export async function archiveProject(db: Db, id: number, reason?: string): Promise<Project> {
  return db.transaction().execute(async (tx) => {
    const project = await loadProject(tx, id);
    if (project.archived_at !== null) {
      throw conflict(`project ${project.key} is already archived`);
    }
    await tx
      .updateTable('project')
      .set({ archived_at: now(), updated_at: now() })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      from_value: 'active',
      kind: 'archive',
      project_id: id,
      reason: reason ?? null,
      to_value: 'archived',
    });
    return loadProject(tx, id);
  });
}

/**
 * The out-of-project leaf tasks actually **released** by archiving `projectId`
 * (ADR 0015 Refinement) — call it *after* the archive has landed. A task counts
 * as released iff it is now `ready` **and** an effective prerequisite (its own
 * edge or an ancestor's) is a node in this project that was *not* already
 * settled — i.e. it was gating (the task was `awaiting`) and the archive is what
 * freed it. Reporting only genuine flips (not every edge-holder) keeps the
 * warning honest: no false positives for still-awaiting multi-prereq tasks,
 * terminal tasks, or tasks already ready for other reasons. Names the leaf, not
 * the edge-holding container.
 */
export async function releasedByArchive(db: Db, projectId: number): Promise<string[]> {
  // The prerequisites this archive just settled: nodes in the project that were
  // not already terminal on their own (a done/abandoned prereq gated nothing).
  const nodes = await db
    .selectFrom('node')
    .select(['id', 'type', 'lifecycle'])
    .where('project_id', '=', projectId)
    .execute();
  const settling = new Set<number>();
  for (const node of nodes) {
    if (!(await isNodeSettled(db, node))) {
      settling.add(node.id);
    }
  }
  if (settling.size === 0) {
    return [];
  }

  // Out-of-project actionable tasks whose effective prereqs touch a settling
  // node and that are now ready → the archive is what released them.
  const candidates = await db
    .selectFrom('node')
    .selectAll()
    .where('project_id', '<>', projectId)
    .where('type', '=', 'task')
    .where('lifecycle', '=', 'todo')
    .where('hold', '=', 'none')
    .execute();
  const released: string[] = [];
  for (const task of candidates) {
    const lineage = await lineageIds(db, task.id);
    const edges = await db
      .selectFrom('dependency')
      .select('depends_on_node_id')
      .where('node_id', 'in', lineage)
      .execute();
    if (!edges.some((e) => settling.has(e.depends_on_node_id))) {
      continue;
    }
    if (!(await isReady(db, task))) {
      continue;
    }
    const rendered = await renderNodeId(db, task.id);
    if (rendered !== null) {
      released.push(rendered);
    }
  }
  return released.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Unarchive a project (archived → active). Unarchiving an active project is a conflict. */
export async function unarchiveProject(db: Db, id: number): Promise<Project> {
  return db.transaction().execute(async (tx) => {
    const project = await loadProject(tx, id);
    if (project.archived_at === null) {
      throw conflict(`project ${project.key} is not archived`);
    }
    await tx
      .updateTable('project')
      .set({ archived_at: null, updated_at: now() })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      from_value: 'archived',
      kind: 'archive',
      project_id: id,
      reason: null,
      to_value: 'active',
    });
    return loadProject(tx, id);
  });
}
