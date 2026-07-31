import { HANDLE_FIELD_KEYS } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';

import type { ArtifactMetadataPatch, ArtifactRecord } from '../artifacts/store';
import { deriveSet } from '../derive';
import { invariant, notFound, validation } from '../errors';
import { SPEC_UPDATE_KEYS, updateKeysForTypes } from '../field-spec';
import type { SpecUpdateKey } from '../field-spec';
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

/**
 * Normalize a resume-handle value (MMR-320): newlines collapse to a single space
 * and the result is trimmed, so a handle always renders as one `## History` line;
 * an empty/whitespace-only result stores as `null`, which is how a plain `update`
 * CLEARS a handle (`--host ''`). A `null` input passes through untouched. No cap:
 * a handle is an opaque key into a richer store, not prose (ADR 0026 Decision 3).
 */
export function normalizeHandle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const stripped = value.replace(/\s+/g, ' ').trim();
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
  /**
   * The in-flight resume handles (ADR 0026 Decision 3, MMR-320) — task-only free
   * strings. There is no claim verb: resume or takeover is an ordinary `update`
   * overwrite of these, and a blank clears one.
   */
  host?: string | null;
  harness?: string | null;
  session?: string | null;
  branch?: string | null;
};

export type UpdateFieldKey = keyof UpdateFields;

/** The {@link UpdateFields} slice the resume handles occupy — what `start` records
 * and the terminal/hold verbs clear (ADR 0026 Decision 3). */
export type HandleFields = Pick<UpdateFields, 'branch' | 'harness' | 'host' | 'session'>;

/**
 * Copy the SET resume handles from an update patch onto a {@link NodePatch},
 * normalized (MMR-320) — the one binding `update` and `start` share, so both
 * doors store the identical value. The camelCase update-arg name and the
 * snake_case frontmatter column coincide for all four (they are single words),
 * so one loop over {@link HANDLE_FIELD_KEYS} serves both sides.
 */
export function applyHandlePatch(patch: NodePatch, fields: HandleFields): void {
  for (const key of HANDLE_FIELD_KEYS) {
    const value = fields[key];
    if (value !== undefined) {
      patch[key] = normalizeHandle(value);
    }
  }
}

/**
 * The two update targets outside the data-plane spec (ADR 0025): `title` is
 * always-present node identity and `description` is body prose, not a
 * frontmatter scalar — and both apply across the non-node kinds too, so neither
 * is a node-typed spec field. Everything else in the {@link UpdateFields}
 * vocabulary is a spec `update` field.
 */
const STRUCTURAL_UPDATE_KEYS = ['description', 'title'] as const;

/** Compile guard (MMR-306): every {@link UpdateFields} key must be reachable
 * from the field spec (a `update` field) or the two structural keys — a new key
 * that is neither makes this alias non-`never`, failing {@link Assert} below, so
 * a field can't silently escape the applicability sweep. */
type UnregisteredUpdateKey = Exclude<
  UpdateFieldKey,
  SpecUpdateKey | (typeof STRUCTURAL_UPDATE_KEYS)[number]
>;
type AssertNever<T extends never> = T;
type _AllUpdateKeysRegistered = AssertNever<UnregisteredUpdateKey>;

/**
 * The canonical {@link UpdateFields} vocabulary — the spec's `update` fields plus
 * the two structural targets, sorted into the canonical (alphabetical) order
 * rejection messages list fields in. Derived from the spec, not a parallel table
 * (ADR 0025): a new spec field with an `update` key joins automatically.
 */
const UPDATE_FIELD_KEYS: readonly UpdateFieldKey[] = [
  ...SPEC_UPDATE_KEYS,
  ...STRUCTURAL_UPDATE_KEYS,
].toSorted();

/**
 * The three non-node identities the generic `update` verb also serves
 * (an {@link Identity} `kind` other than `node`) — each narrows
 * {@link UpdateFields} to the handful of keys it actually owns; a project
 * renames on its own `name` field (outside this vocabulary entirely), an
 * artifact's mutable fields are `title` and `summary`, and a seed's are
 * `title`/`description` (`kind` likewise outside this vocabulary).
 */
export type NarrowUpdateKind = 'project' | 'artifact' | 'seed';

const APPLICABLE_UPDATE_FIELDS: Record<NarrowUpdateKind, readonly UpdateFieldKey[]> = {
  artifact: ['summary', 'title'],
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

    // The applicability gates derive from the spec's `appliesTo` (ADR 0025,
    // MMR-306): a field set on a node whose type doesn't carry it is rejected.
    // The three checks keep their established precedence and wording; only WHICH
    // fields are task-only now comes from the spec, not a hand-typed condition.
    const taskOnly = updateKeysForTypes(['task']);
    if (taskOnly.some((key) => fields[key] !== undefined) && node.type !== 'task') {
      throw validation(
        'priority, size, external_ref, upstream, and the execution handles (host, harness, session, branch) apply only to tasks',
      );
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
    // The resume handles (MMR-320) run the shared normalizer, so a blank clears
    // one and a multi-line paste can't break its `## History` echo line.
    applyHandlePatch(patch, fields);

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
  /** The lede (MMR-319) — same 256-char cap as a node's, cleared by a blank. */
  summary?: string | null;
};

/**
 * The dumb `update` for an artifact (MMR-40, MMR-319): `title` and the
 * `summary` lede are the mutable fields — content stays frozen (ADR 0004), so a
 * mistitled or mis-led attach is repairable while the record itself remains
 * immutable. `summary` runs the same {@link normalizeSummary} a node's does, so
 * the cap and its refusal wording are one core fact. Unlogged, like every
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
  const patch: ArtifactMetadataPatch = {};
  if (fields.title !== undefined) {
    patch.title = fields.title;
  }
  if (fields.summary !== undefined) {
    patch.summary = normalizeSummary(fields.summary);
  }
  await store.transact(async (w) => {
    const project = await w.loadProject(ref.key);
    if (project === undefined) {
      throw notFound(`${ref.key}-a${String(ref.seq)} doesn't exist`);
    }
    await assertProjectActive(w, project.key);
  });
  if (Object.keys(patch).length > 0) {
    const found = await store.artifacts.updateMetadata(ref.key, ref.seq, patch);
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
  /** Optional lede (MMR-319) — the same 256-char cap a node's summary carries. */
  summary?: string | null;
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
  // The lede runs the node summary's own normalizer (MMR-319) — one cap, one
  // refusal voice — and is checked before any write, like the title gate above.
  const summary = normalizeSummary(input.summary ?? null);
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
    summary,
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
