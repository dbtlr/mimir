import type { Priority, Size } from '@mimir/contract';

import { invariant, notFound, validation } from '../errors';
import { renderArtifactRef } from '../ids';
import type { Node, Project } from '../model';
import { reorderTask } from '../rank';
import type { RankPosition } from '../rank';
import type { NodePatch, ProjectPatch, Store } from '../store';
import { now } from '../time';
import {
  assertProjectActive,
  reloadNode,
  renderNodeRef,
  requireNode,
  requireTask,
  stamp,
} from './common';

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

export async function updateNode(store: Store, id: number, fields: UpdateFields): Promise<Node> {
  return store.transact(async (w) => {
    const node = await requireNode(w, id);

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

    const patch: NodePatch = {};
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
      await w.updateNode(id, patch);
    }
    return reloadNode(w, id);
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
  store: Store,
  id: number,
  fields: UpdateProjectFields,
): Promise<Project> {
  return store.transact(async (w) => {
    const project = await w.loadProject(id);
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    await assertProjectActive(w, id);
    if (fields.name !== undefined && fields.name.trim() === '') {
      throw validation('project name cannot be blank');
    }
    const patch: ProjectPatch = {};
    if (fields.name !== undefined) {
      patch.name = fields.name;
    }
    if (fields.description !== undefined) {
      patch.description = fields.description;
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = now();
      await w.updateProject(id, patch);
    }
    const updated = await w.loadProject(id);
    if (updated === undefined) {
      throw invariant('the record vanished mid-transaction');
    }
    return updated;
  });
}

export async function annotate(store: Store, id: number, content: string): Promise<Node> {
  return store.transact(async (w) => {
    await requireNode(w, id);
    await w.insertAnnotation({ content, node_id: id });
    await stamp(w, id); // in-flight activity moves the task (affects stale)
    return reloadNode(w, id);
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
  store: Store,
  id: number,
  fields: ArtifactUpdateFields,
): Promise<void> {
  if (fields.title !== undefined && fields.title.trim() === '') {
    throw validation('an artifact title cannot be blank');
  }
  await store.transact(async (w) => {
    const artifact = await w.loadArtifact(id);
    if (artifact === undefined) {
      throw notFound('the artifact was not found');
    }
    await assertProjectActive(w, artifact.project_id);
    if (fields.title !== undefined) {
      await w.updateArtifact(id, { title: fields.title });
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
  store: Store,
  input: AttachArtifactInput,
): Promise<{ id: number; renderedId: string }> {
  if (input.title.trim() === '') {
    throw validation('attach requires a title');
  }
  return store.transact(async (w) => {
    const project = await w.loadProject(input.projectId);
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    await assertProjectActive(w, input.projectId);
    const seq = await w.allocateArtifactSeq(input.projectId);
    const artifact = await w.insertArtifact({
      content: input.content,
      project_id: input.projectId,
      seq,
      title: input.title,
    });
    for (const tag of input.tags ?? []) {
      await w.insertTag({ entity_id: artifact.id, entity_type: 'artifact', note: null, tag });
    }
    for (const nodeId of input.linkNodeIds ?? []) {
      const node = await requireNode(w, nodeId);
      if (node.project_id !== input.projectId) {
        const rendered = (await renderNodeRef(w, nodeId)) ?? 'it';
        throw validation(`${rendered} is in a different project — links stay within one project`);
      }
      await w.linkArtifact(artifact.id, nodeId);
    }
    return { id: artifact.id, renderedId: renderArtifactRef({ key: project.key, seq }) };
  });
}

export async function reorder(
  store: Store,
  id: number,
  position: RankPosition,
  refId: number | null = null,
): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.rank === null) {
      throw validation(
        'cannot reorder a task outside the rankable set (terminal, held, or under review)',
      );
    }
    await reorderTask(w, task.project_id, id, position, refId);
    return reloadNode(w, id);
  });
}
