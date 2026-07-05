import type { Db, Tx } from './context';
import { renderId } from './ids';

/** Render a node's external `KEY-seq` id from its surrogate id (joins the project key). */
export async function renderNodeId(tx: Db | Tx, nodeId: number): Promise<string | null> {
  const row = await tx
    .selectFrom('node')
    .innerJoin('project', 'project.id', 'node.project_id')
    .select(['project.key as key', 'node.seq as seq'])
    .where('node.id', '=', nodeId)
    .executeTakeFirst();
  return row === undefined ? null : renderId(row);
}

/** Render a project's external `KEY` from its surrogate id (project-keyed transition rows, ADR 0015). */
export async function renderProjectKey(tx: Db | Tx, projectId: number): Promise<string | null> {
  const row = await tx
    .selectFrom('project')
    .select('key')
    .where('id', '=', projectId)
    .executeTakeFirst();
  return row?.key ?? null;
}
