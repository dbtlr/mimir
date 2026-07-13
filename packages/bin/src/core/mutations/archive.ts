import { deriveSet, isNodeSettled, lineageIds } from '../derive';
import { conflict, notFound } from '../errors';
import type { Project } from '../model';
import { isReady } from '../predicates';
import type { Store, StoreWriter } from '../store';
import { now } from '../time';
import { logTransition } from './common';

/**
 * Project archive (ADR 0015). Archiving sets `project.archived_at` and freezes
 * the whole subtree (the write-lock lives in `requireNode` /
 * `assertProjectActive`); unarchiving clears it. Both are reversible,
 * reason-bearing transitions logged against the **project** (the entity-keyed
 * `transition_log`) — never a delete, so append-only holds.
 */

async function loadProject(w: StoreWriter, id: string): Promise<Project> {
  const project = await w.loadProject(id);
  if (project === undefined) {
    throw notFound('the project was not found');
  }
  return project;
}

/** Archive a project (active → archived). Idempotency is a conflict, not a no-op. */
export async function archiveProject(store: Store, id: string, reason?: string): Promise<Project> {
  return store.transact(async (w) => {
    const project = await loadProject(w, id);
    if (project.archived_at !== null) {
      throw conflict(`project ${project.key} is already archived`);
    }
    await w.updateProject(id, { archived_at: now(), updated_at: now() });
    await logTransition(w, {
      from_value: 'active',
      kind: 'archive',
      project_id: id,
      reason: reason ?? null,
      to_value: 'archived',
    });
    return loadProject(w, id);
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
export async function releasedByArchive(store: Store, projectId: string): Promise<string[]> {
  const set = deriveSet(await store.loadWorkingSet());
  // The prerequisites this archive just settled: nodes in the project that were
  // not already terminal on their own (a done/abandoned prereq gated nothing).
  const settling = new Set<string>();
  for (const node of set.nodesByProject.get(projectId) ?? []) {
    if (!isNodeSettled(set, node)) {
      settling.add(node.id);
    }
  }
  if (settling.size === 0) {
    return [];
  }

  // Out-of-project actionable tasks whose effective prereqs touch a settling
  // node and that are now ready → the archive is what released them.
  const candidates = set.ws.nodes.filter(
    (n) =>
      n.project_id !== projectId &&
      n.type === 'task' &&
      n.lifecycle === 'todo' &&
      n.hold === 'none',
  );
  const released: string[] = [];
  for (const task of candidates) {
    const touches = lineageIds(set, task.id).some((ancestorId) =>
      (set.prereqsByNode.get(ancestorId) ?? []).some((prereqId) => settling.has(prereqId)),
    );
    if (!touches) {
      continue;
    }
    if (!isReady(set, task)) {
      continue;
    }
    released.push(task.id);
  }
  return released.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Unarchive a project (archived → active). Unarchiving an active project is a conflict. */
export async function unarchiveProject(store: Store, id: string): Promise<Project> {
  return store.transact(async (w) => {
    const project = await loadProject(w, id);
    if (project.archived_at === null) {
      throw conflict(`project ${project.key} is not archived`);
    }
    await w.updateProject(id, { archived_at: null, updated_at: now() });
    await logTransition(w, {
      from_value: 'archived',
      kind: 'archive',
      project_id: id,
      reason: null,
      to_value: 'active',
    });
    return loadProject(w, id);
  });
}
