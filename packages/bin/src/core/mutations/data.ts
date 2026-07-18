import type { Priority, Size } from '@mimir/contract';

import type { ArtifactRecord } from '../artifacts/store';
import { deriveSet } from '../derive';
import { invariant, notFound, validation } from '../errors';
import { renderArtifactRef } from '../ids';
import type { Node, Project } from '../model';
import { reorderTask } from '../rank';
import type { RankPosition } from '../rank';
import { resolveNodeTokenInSet, resolveProjectKeyInSet } from '../resolve-set';
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

/** The canonical {@link UpdateFields} vocabulary, in declaration order. */
const UPDATE_FIELD_KEYS = [
  'title',
  'description',
  'summary',
  'priority',
  'size',
  'target',
  'externalRef',
  'upstream',
  'openEnded',
] as const satisfies readonly (keyof UpdateFields)[];

export type UpdateFieldKey = (typeof UPDATE_FIELD_KEYS)[number];

/**
 * The three non-node identities the generic `update` verb also serves
 * (an {@link Identity} `kind` other than `node`) — each narrows
 * {@link UpdateFields} to the handful of keys it actually owns; a project
 * renames on its own `name` field (outside this vocabulary entirely), an
 * artifact's one mutable field is `title`, and a seed's are
 * `title`/`description` (`kind` likewise outside this vocabulary).
 */
export type NarrowUpdateKind = 'project' | 'artifact' | 'seed';

const APPLICABLE_UPDATE_FIELDS: Record<NarrowUpdateKind, readonly UpdateFieldKey[]> = {
  artifact: ['title'],
  project: ['description'],
  seed: ['title', 'description'],
};

/**
 * The per-kind field-applicability table (MMR-306) — the single domain fact
 * of which {@link UpdateFields} keys a project/artifact/seed update rejects
 * (the complement of what it owns, in canonical order). The CLI and MCP
 * transports each used to hand-type this same "doesn't apply to a …" list
 * per kind; they now share this one declaration and keep only their own
 * rejection wording and flag/arg spelling (the established hint-seam split —
 * the table owns WHICH fields, the transport owns HOW that's phrased). A
 * plain node (`task`/`phase`/`initiative`) update has its own field-gating
 * inside {@link updateNode} below (task-only vs container-only fields) and is
 * out of scope here — this table is for the three kinds that aren't a `Node`
 * at all.
 */
export function inapplicableUpdateFields(kind: NarrowUpdateKind): readonly UpdateFieldKey[] {
  const applicable = new Set(APPLICABLE_UPDATE_FIELDS[kind]);
  return UPDATE_FIELD_KEYS.filter((key) => !applicable.has(key));
}

export async function updateNode(store: Store, id: string, fields: UpdateFields): Promise<Node> {
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
  id: string,
  fields: UpdateProjectFields,
): Promise<Project> {
  return store.transact(async (w) => {
    const project = await w.loadProject(id);
    if (project === undefined) {
      throw notFound(`${id} doesn't exist`);
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

export async function annotate(store: Store, id: string, content: string): Promise<Node> {
  return store.transact(async (w) => {
    await requireNode(w, id);
    // Core-stamp the created-at (MMR-173) rather than lean on the DB default, so
    // every write path persists the same value.
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
 * Keyed by canonical artifact stem (MMR-143), with no second identity scheme.
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
    const project = await w.loadProject(ref.key);
    if (project === undefined) {
      throw notFound(`${ref.key}-a${String(ref.seq)} doesn't exist`);
    }
    await assertProjectActive(w, project.key);
  });
  if (fields.title !== undefined) {
    const found = await store.artifacts.updateTitle(ref.key, ref.seq, fields.title);
    if (!found) {
      throw notFound(`${ref.key}-a${String(ref.seq)} doesn't exist`);
    }
  }
}

export type AttachArtifactInput = {
  projectId: string;
  /** Required (MMR-34): the human handle every artifact carries. */
  title: string;
  content: string;
  linkNodeIds?: string[];
  /** Attach-and-classify is one intent — creation-time tags on the artifact. */
  tags?: string[];
};

/**
 * `attachArtifact`'s return, echoing the just-written record IN FULL (MMR-283,
 * mirroring `seeds.create`): `renderedId` for callers that only need the id
 * (CLI/MCP), `record` for a wire echo (HTTP) — everything a create response
 * renders, with no follow-up `getArtifact` read. Project-activeness is
 * asserted by `assertProjectActive` below, in the node transaction that
 * precedes the (separate, non-atomic) artifact write — an archive landing in
 * that window is the accepted concurrency posture (ADR 0023), and the echo
 * truthfully reports the write that occurred rather than re-checking and
 * misreporting a landed write as absent.
 */
export type AttachArtifactResult = {
  renderedId: string;
  record: ArtifactRecord & { content: string };
};

/**
 * Attach an artifact (MMR-34). Node-side validation (project active, links
 * in-project) runs in one transaction; the artifact write is a separate call
 * because it may target a different backend (ADR 0016 Phase 2a) that can't
 * join the node write's transaction.
 *
 * Transitional non-atomicity: an `archive` that commits between the two would
 * let the artifact land against a now-archived project, where reads hide it —
 * but the artifact is *hidden, not lost* (`unarchive` restores it), and full
 * atomicity returns at Phase 3 when nodes and artifacts share one backend.
 */
export async function attachArtifact(
  store: Store,
  input: AttachArtifactInput,
): Promise<AttachArtifactResult> {
  if (input.title.trim() === '') {
    throw validation('attach requires a title');
  }
  // Validate the project and every link against the node backend, and render
  // the link stems, before the artifact write hits its own (possibly Norn)
  // backend — the invariants stay verb-side (MMR-143). `assertProjectActive`
  // runs BEFORE the artifact write below, so the project is known active at
  // write time — the echo needs no second active check (MMR-283).
  const { projectKey, linkStems } = await store.transact(async (w) => {
    const project = await w.loadProject(input.projectId);
    if (project === undefined) {
      throw notFound(`${input.projectId} doesn't exist`);
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
  const record = await store.artifacts.create({
    content: input.content,
    key: projectKey,
    links: linkStems,
    tags: input.tags ?? [],
    title: input.title,
  });
  return { record, renderedId: renderArtifactRef({ key: record.key, seq: record.seq }) };
}

/**
 * Transport-supplied hint lines for attach link-resolution errors — the
 * {@link resolveNodeTokenInSet} hint seam carried through, so each envelope can
 * point at its own surface (the CLI at `mimir list`, HTTP at its routes) while
 * the wording stays core-owned. Mirrors `CreateParentHints` (MMR-304/305).
 */
export type AttachLinkHints = {
  project?: string;
  artifact?: string;
  seed?: string;
  notFound?: string;
};

/** The resolved attach target: the owning project and the deduped link ids. */
export type AttachTargets = {
  projectId: string;
  linkNodeIds: string[];
};

/**
 * Resolve the attach link-set and its owning project (MMR-305) — the one
 * algorithm the CLI, MCP, and HTTP envelopes used to each re-implement. `tokens`
 * are the raw node refs a transport gathered (HTTP's path anchor is simply the
 * first token). Each is resolved against ONE working-set snapshot with the
 * kind-aware guard (a project/artifact/seed token is named as such rather than a
 * fake `doesn't exist`, MMR-304 parity; a genuine node miss keeps `X doesn't
 * exist`), deduped by resolved id (a link equal to the anchor, or any repeated
 * token, collapses), and required to share one project. An `explicitProject`
 * (CLI `--project`, MCP `project`) must agree with the links' project when links
 * exist; with no links it resolves the project on its own (`not_found` for an
 * unknown key).
 *
 * The zero-token / no-`explicitProject` case is the transport's own
 * required-argument error (its native class + wording) and is guarded upstream;
 * reaching it here is an internal invariant break.
 */
export async function resolveAttachTargets(
  store: Store,
  tokens: string[],
  explicitProject?: string,
  hints: AttachLinkHints = {},
): Promise<AttachTargets> {
  const set = deriveSet(await store.loadWorkingSet());
  if (tokens.length === 0) {
    if (explicitProject === undefined) {
      throw invariant('attach resolution reached with neither a link nor a project');
    }
    return { linkNodeIds: [], projectId: resolveProjectKeyInSet(set, explicitProject) };
  }
  const linkNodeIds: string[] = [];
  let projectId: string | undefined;
  for (const token of tokens) {
    const id = resolveNodeTokenInSet(set, token, 'task, phase, or initiative', hints);
    const node = set.nodeById.get(id);
    if (node === undefined) {
      throw invariant('a resolved link vanished from the working set');
    }
    if (projectId === undefined) {
      projectId = node.project_id;
    } else if (node.project_id !== projectId) {
      throw validation('all the links must be in one project');
    }
    if (!linkNodeIds.includes(id)) {
      linkNodeIds.push(id);
    }
  }
  if (projectId === undefined) {
    throw invariant('links resolved but project is missing');
  }
  if (explicitProject !== undefined) {
    const explicit = resolveProjectKeyInSet(set, explicitProject);
    if (explicit !== projectId) {
      throw validation("the project disagrees with the links' project");
    }
  }
  return { linkNodeIds, projectId };
}

export async function reorder(
  store: Store,
  id: string,
  position: RankPosition,
  refId: string | null = null,
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
