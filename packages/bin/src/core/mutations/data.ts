import type { Priority, Size } from '@mimir/contract';

import type { Node, NodeUpdate, Project } from '../../db/schema';
import { allocateArtifactSeq } from '../allocation';
import type { Db } from '../context';
import { notFound, validation } from '../errors';
import { renderArtifactRef } from '../ids';
import { renderNodeId } from '../lookup';
import { reorderTask } from '../rank';
import type { RankPosition } from '../rank';
import { now } from '../time';
import { reloadNode, requireNode, requireTask, stamp } from './common';

/**
 * Data + structural-order verbs that aren't status-bearing: the dumb `update`
 * patch (status axes / rank / seq / type / parent deliberately excluded — those
 * have their own verbs), freeform annotations, frozen artifacts, and `reorder`
 * (a pure rank change — no transition log, and `rank` is invisible so it does
 * not stamp `updated_at`).
 */

export type UpdateFields = {
  title?: string;
  description?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  target?: string | null;
  externalRef?: string | null;
};

export async function updateNode(db: Db, id: number, fields: UpdateFields): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const node = await requireNode(tx, id);

    const wantsTaskField =
      fields.priority !== undefined ||
      fields.size !== undefined ||
      fields.externalRef !== undefined;
    if (wantsTaskField && node.type !== 'task') {
      throw validation('priority, size, and external_ref apply only to tasks');
    }
    if (fields.target !== undefined && node.type !== 'phase') {
      throw validation('target applies only to phases');
    }

    const patch: NodeUpdate = {};
    if (fields.title !== undefined) {
      patch.title = fields.title;
    }
    if (fields.description !== undefined) {
      patch.description = fields.description;
    }
    if (fields.priority !== undefined) {
      patch.priority = fields.priority;
    }
    if (fields.size !== undefined) {
      patch.size = fields.size;
    }
    if (fields.target !== undefined) {
      patch.target = fields.target;
    }
    if (fields.externalRef !== undefined) {
      patch.external_ref = fields.externalRef;
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = now();
      await tx.updateTable('node').set(patch).where('id', '=', id).execute();
    }
    return reloadNode(tx, id);
  });
}

export type UpdateProjectFields = {
  name?: string;
  description?: string | null;
};

/**
 * The dumb scalar patcher for a project row (MMR-88): `name` and `description`
 * are the only mutable fields — `key` is immutable. No transition log (projects
 * have no status). Returns the updated project row directly.
 */
export async function updateProject(
  db: Db,
  id: number,
  fields: UpdateProjectFields,
): Promise<Project> {
  return db.transaction().execute(async (tx) => {
    const project = await tx
      .selectFrom('project')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    if (fields.name !== undefined && fields.name.trim() === '') {
      throw validation('project name cannot be blank');
    }
    const patch: Record<string, unknown> = {};
    if (fields.name !== undefined) {
      patch.name = fields.name;
    }
    if (fields.description !== undefined) {
      patch.description = fields.description;
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = now();
      await tx.updateTable('project').set(patch).where('id', '=', id).execute();
    }
    return (await tx
      .selectFrom('project')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as Project;
  });
}

export async function annotate(db: Db, id: number, content: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    await tx.insertInto('annotation').values({ content, node_id: id }).execute();
    await stamp(tx, id); // in-flight activity moves the task (affects stale)
    return reloadNode(tx, id);
  });
}

export type ArtifactUpdateFields = {
  title?: string;
};

/**
 * The dumb `update` for an artifact (MMR-40): `title` is the only mutable
 * field — content stays frozen (ADR 0004), so a mistitled attach is
 * repairable while the record itself remains immutable. Unlogged, like every
 * metadata patch (the transition log records status transitions).
 */
export async function updateArtifact(
  db: Db,
  id: number,
  fields: ArtifactUpdateFields,
): Promise<void> {
  if (fields.title !== undefined && fields.title.trim() === '') {
    throw validation('an artifact title cannot be blank');
  }
  await db.transaction().execute(async (tx) => {
    const artifact = await tx
      .selectFrom('artifact')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (artifact === undefined) {
      throw notFound('the artifact was not found');
    }
    if (fields.title !== undefined) {
      await tx.updateTable('artifact').set({ title: fields.title }).where('id', '=', id).execute();
    }
  });
}

export type AttachArtifactInput = {
  projectId: number;
  /** Required (MMR-34): the human handle every artifact carries. */
  title: string;
  content: string;
  linkNodeIds?: number[];
  /** Attach-and-classify is one intent — creation-time tags on the artifact. */
  tags?: string[];
};

export async function attachArtifact(
  db: Db,
  input: AttachArtifactInput,
): Promise<{ id: number; renderedId: string }> {
  if (input.title.trim() === '') {
    throw validation('attach requires a title');
  }
  return db.transaction().execute(async (tx) => {
    const project = await tx
      .selectFrom('project')
      .select('key')
      .where('id', '=', input.projectId)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    const seq = await allocateArtifactSeq(tx, input.projectId);
    const artifact = await tx
      .insertInto('artifact')
      .values({ content: input.content, project_id: input.projectId, seq, title: input.title })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const tag of input.tags ?? []) {
      await tx
        .insertInto('tag')
        .values({ entity_id: artifact.id, entity_type: 'artifact', note: null, tag })
        .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doNothing())
        .execute();
    }
    for (const nodeId of input.linkNodeIds ?? []) {
      const node = await requireNode(tx, nodeId);
      if (node.project_id !== input.projectId) {
        const rendered = (await renderNodeId(tx, nodeId)) ?? 'it';
        throw validation(`${rendered} is in a different project — links stay within one project`);
      }
      await tx
        .insertInto('artifact_link')
        .values({ artifact_id: artifact.id, node_id: nodeId })
        .execute();
    }
    return { id: artifact.id, renderedId: renderArtifactRef({ key: project.key, seq }) };
  });
}

export async function reorder(
  db: Db,
  id: number,
  position: RankPosition,
  refId: number | null = null,
): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.rank === null) {
      throw validation(
        'cannot reorder a task outside the rankable set (terminal, held, or under review)',
      );
    }
    await reorderTask(tx, task.project_id, id, position, refId);
    return reloadNode(tx, id);
  });
}
