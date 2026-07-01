import type { Project } from '../../db/schema';
import type { Db, Tx } from '../context';
import { conflict, notFound } from '../errors';
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
