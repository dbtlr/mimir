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

const SUMMARY_MAX_LENGTH = 256;

/**
 * Normalize a `summary` value (MMR-162): newlines collapse to a single space,
 * then the result is trimmed. An empty/whitespace-only result stores as
 * `null`. A `null` input is passed through untouched — a `null`/undefined
 * summary carries no validation. Over-length input is a hard reject (never
 * silently truncated) — the caller decides whether to skip the call for an
 * `undefined` value (no change).
 */
export function normalizeSummary(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const stripped = value.replace(/[\r\n]+/g, ' ').trim();
  if (stripped.length > SUMMARY_MAX_LENGTH) {
    throw validation(
      `summary must be ${SUMMARY_MAX_LENGTH} characters or fewer (got ${stripped.length})`,
    );
  }
  return stripped === '' ? null : stripped;
}

export type UpdateFields = {
  title?: string;
  description?: string | null;
  /** The short list lede (MMR-162) — all-node, never type-gated. */
  summary?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  target?: string | null;
  externalRef?: string | null;
  /** The requester-side seed pointer (`KEY-sN`), task-only, nullable (MMR-244). */
  upstream?: string | null;
  /** Container-only (phase/initiative) — opt in/out of open-ended (MMR-204). */
  openEnded?: boolean;
};

export async function updateNode(store: Store, id: number, fields: UpdateFields): Promise<Node> {
  return store.transact(async (w) => {
    const node = await requireNode(w, id);

    const wantsTaskField =
      fields.priority !== undefined ||
      fields.size !== undefined ||
      fields.externalRef !== undefined ||
      fields.upstream !== undefined;
    if (wantsTaskField && node.type !== 'task') {
      throw validation('priority, size, external_ref, and upstream apply only to tasks');
    }
    if (fields.target !== undefined && node.type !== 'phase') {
      throw validation('target applies only to phases');
    }
    if (fields.openEnded !== undefined && node.type === 'task') {
      throw validation('open_ended applies only to phases and initiatives');
    }

    const patch: NodePatch = {};
    if (fields.title !== undefined) {
      patch.title = fields.title;
    }
    if (fields.description !== undefined) {
      patch.description = fields.description;
    }
    if (fields.summary !== undefined) {
      patch.summary = normalizeSummary(fields.summary);
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
    if (fields.upstream !== undefined) {
      patch.upstream = fields.upstream;
    }
    if (fields.openEnded !== undefined) {
      patch.open_ended = fields.openEnded;
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
    // Core-stamp the created-at (MMR-173) rather than lean on the DB default, so
    // the SQLite and Norn backends persist the same value.
    await w.insertAnnotation({ content, created_at: now(), node_id: id });
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
 * Keyed by external identity (MMR-143) — the artifact seam has no numeric ids.
 */
export async function updateArtifact(
  store: Store,
  ref: { key: string; seq: number },
  fields: ArtifactUpdateFields,
): Promise<void> {
  if (fields.title !== undefined && fields.title.trim() === '') {
    throw validation('an artifact title cannot be blank');
  }
  await store.transact(async (w) => {
    const project = await w.loadProjectByKey(ref.key);
    if (project === undefined) {
      throw notFound('the artifact was not found');
    }
    await assertProjectActive(w, project.id);
  });
  if (fields.title !== undefined) {
    const found = await store.artifacts.updateTitle(ref.key, ref.seq, fields.title);
    if (!found) {
      throw notFound('the artifact was not found');
    }
  }
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

/**
 * Attach an artifact (MMR-34). Node-side validation (project active, links
 * in-project) runs in one transaction; the artifact write is a separate call
 * because it may target a different backend (ADR 0016 Phase 2a) that can't
 * join the SQLite transaction.
 *
 * Transitional non-atomicity: an `archive` that commits between the two would
 * let the artifact land against a now-archived project, where reads hide it —
 * but the artifact is *hidden, not lost* (`unarchive` restores it), and full
 * atomicity returns at Phase 3 when nodes and artifacts share one backend.
 */
export async function attachArtifact(
  store: Store,
  input: AttachArtifactInput,
): Promise<{ renderedId: string }> {
  if (input.title.trim() === '') {
    throw validation('attach requires a title');
  }
  // Validate the project and every link against the node backend, and render
  // the link stems, before the artifact write hits its own (possibly Norn)
  // backend — the invariants stay verb-side (MMR-143).
  const { projectKey, linkStems } = await store.transact(async (w) => {
    const project = await w.loadProject(input.projectId);
    if (project === undefined) {
      throw notFound('the project was not found');
    }
    await assertProjectActive(w, input.projectId);
    const stems: string[] = [];
    for (const nodeId of input.linkNodeIds ?? []) {
      const node = await requireNode(w, nodeId);
      if (node.project_id !== input.projectId) {
        const rendered = (await renderNodeRef(w, nodeId)) ?? 'it';
        throw validation(`${rendered} is in a different project — links stay within one project`);
      }
      const rendered = await renderNodeRef(w, nodeId);
      if (rendered !== null) {
        stems.push(rendered);
      }
    }
    return { linkStems: stems, projectKey: project.key };
  });
  const { key, seq } = await store.artifacts.create({
    content: input.content,
    key: projectKey,
    links: linkStems,
    tags: input.tags ?? [],
    title: input.title,
  });
  return { renderedId: renderArtifactRef({ key, seq }) };
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
