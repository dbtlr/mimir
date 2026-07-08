import type { Priority, SeedKind, SeedLifecycle, Size, SeedView } from '@mimir/contract';

import { createTask } from '../create';
import type { DerivationSet } from '../derive';
import { deriveSet, findNodeInSet, isNodeSettled, renderNodeIdFromSet } from '../derive';
import { notFound, projectNotFound, validation } from '../errors';
import { parseSeedRef, renderId, renderSeedRef } from '../ids';
import type { Store } from '../store';
import { isTerminalSeed } from './store';
import type { SeedRecord } from './store';

/**
 * The seed verb surface (MMR-245) — the transport-agnostic read + mutation
 * layer the CLI, MCP, and HTTP all render, paralleling the node intent layer.
 *
 * **The resolving read seam.** Every verb-facing read routes through
 * {@link seedResolver} + {@link resolveSeedView}, mirroring how the node reader
 * consumes `validate`'s valid subgraph (`loadNornSnapshot`): the per-record
 * store decoder stays dumb, and it is HERE that a read nulls/prunes what the
 * validator would drop — an unknown `requester` reads as `null`, a `spawned`
 * ref that resolves to no surviving work node is pruned. Deriving over one
 * working-set snapshot also lets the read compute `readyToResolve` live (the
 * house rule: derive, never store).
 */

/** The seed queue universe (MMR-245): a lifecycle word, or the `live`/`all` unions. */
export type SeedStatusSelector = SeedLifecycle | 'live' | 'all';

/** The live universe — the untriaged + in-flight seeds (`new` + `promoted`). */
const isLive = (lifecycle: SeedLifecycle): boolean =>
  lifecycle === 'new' || lifecycle === 'promoted';

/**
 * The shared read context: the active project keys (an unknown `requester`
 * nulls against this) plus the derived working set (spawned refs + settledness
 * resolve against its surviving nodes). Archived projects read as absent
 * (ADR 0015), so their keys and nodes are excluded from resolution.
 */
type SeedResolver = { projectKeys: ReadonlySet<string>; set: DerivationSet };

async function seedResolver(store: Store): Promise<SeedResolver> {
  const set = deriveSet(await store.loadWorkingSet());
  const projectKeys = new Set(
    set.ws.projects.filter((p) => p.archived_at === null).map((p) => p.key),
  );
  return { projectKeys, set };
}

/**
 * A stored seed record → its resolved verb-facing view. The one seam where the
 * verbs null/prune what the validator would drop: an unknown `requester` → null,
 * a dangling `spawned` ref → pruned. `readyToResolve` is derived from the pruned
 * survivors — a `promoted` seed with ≥1 surviving spawned node, all settled.
 */
function resolveSeedView(
  rec: SeedRecord & { description?: string | null },
  r: SeedResolver,
): SeedView {
  const requester =
    rec.requester !== null && !r.projectKeys.has(rec.requester) ? null : rec.requester;
  const spawned = rec.spawned.filter((stem) => findNodeInSet(r.set, stem) !== undefined);
  const readyToResolve =
    rec.lifecycle === 'promoted' &&
    spawned.length > 0 &&
    spawned.every((stem) => {
      const node = findNodeInSet(r.set, stem);
      return node !== undefined && isNodeSettled(r.set, node);
    });
  const view: SeedView = {
    createdAt: rec.created_at,
    id: renderSeedRef({ key: rec.key, seq: rec.seq }),
    kind: rec.kind,
    lifecycle: rec.lifecycle,
    project: rec.key,
    readyToResolve,
    requester,
    spawned,
    title: rec.title,
    updatedAt: rec.updated_at,
  };
  if ('description' in rec) {
    view.description = rec.description ?? null;
  }
  return view;
}

export type ListSeedsOptions = {
  /** The target board whose queue to read; absent = every active project. */
  project?: string;
  /** Requester-side filter — seeds whose (resolved) requester is this project key. */
  requester?: string;
  /** The queue universe (default `live` = new + promoted). */
  status?: SeedStatusSelector;
  /** Order by age (`created_at`): `asc` = oldest-first (FIFO, the default). */
  sort?: 'asc' | 'desc';
};

/**
 * `seeds` — the queue read (MMR-245). Default: LIVE only (new + promoted),
 * OLDEST-first (the longest-waiting seed is the triage priority). Scoped to one
 * board via `project`, or every active project when absent; `requester` filters
 * to the requester-side listing. Reads through the resolving seam, so an unknown
 * requester and dangling spawned refs are already nulled/pruned.
 */
export async function listSeeds(store: Store, opts: ListSeedsOptions = {}): Promise<SeedView[]> {
  const r = await seedResolver(store);
  if (opts.project !== undefined && !r.projectKeys.has(opts.project)) {
    throw projectNotFound(opts.project);
  }
  const keys = opts.project !== undefined ? [opts.project] : [...r.projectKeys];
  const records: SeedRecord[] = [];
  for (const key of keys) {
    records.push(...(await store.seeds.listForProject(key)));
  }
  const status = opts.status ?? 'live';
  let views = records.map((rec) => resolveSeedView(rec, r));
  if (opts.requester !== undefined) {
    views = views.filter((v) => v.requester === opts.requester);
  }
  views = views.filter((v) => {
    if (status === 'all') {
      return true;
    }
    if (status === 'live') {
      return isLive(v.lifecycle);
    }
    return v.lifecycle === status;
  });
  // Oldest-first FIFO by created_at, id the stable tiebreak; desc reverses it.
  views.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  if (opts.sort === 'desc') {
    views.reverse();
  }
  return views;
}

function cmp(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * `get KEY-sN` — one seed's resolved view (MMR-245); the `## Seed Description`
 * prose via the opt-in `content` read. A seed whose owning project reads as
 * absent (or a non-seed id) throws `not_found`.
 */
export async function getSeed(
  store: Store,
  id: string,
  opts: { content?: boolean } = {},
): Promise<SeedView> {
  const ref = parseSeedRef(id);
  if (ref === null) {
    throw notFound(`${id} is not a seed id`, 'seed ids look like KEY-sN');
  }
  const r = await seedResolver(store);
  if (!r.projectKeys.has(ref.key)) {
    throw notFound(`no seed ${id}`);
  }
  const rec = await store.seeds.load(ref.key, ref.seq, opts);
  if (rec === undefined) {
    throw notFound(`no seed ${id}`);
  }
  return resolveSeedView(rec, r);
}

export type FileSeedInput = {
  /** The target project (the board the seed is filed against). */
  project: string;
  title: string;
  kind: SeedKind;
  /** Prose for the `## Seed Description` body section (never frontmatter). */
  description?: string | null;
  /** Requester-side project key; `null` = self-filed at the target board. */
  requester?: string | null;
};

/**
 * `seed` — file a seed (MMR-245). The target project must be active; a
 * non-`null` requester must name a known project. Echoes the created record.
 */
export async function fileSeed(store: Store, input: FileSeedInput): Promise<SeedView> {
  if (input.title.trim() === '') {
    throw validation('a seed requires a title');
  }
  const r = await seedResolver(store);
  if (!r.projectKeys.has(input.project)) {
    throw projectNotFound(input.project);
  }
  if (input.requester != null && input.requester !== '' && !r.projectKeys.has(input.requester)) {
    throw validation(
      `requester ${input.requester} is not a known project`,
      'the requester is a board key (KEY); omit it to self-file',
    );
  }
  const { key, seq } = await store.seeds.create({
    description: input.description ?? null,
    key: input.project,
    kind: input.kind,
    requester: input.requester ?? null,
    title: input.title,
  });
  return getSeed(store, renderSeedRef({ key, seq }), { content: true });
}

export type PromoteSeedInput = {
  /** Create mode: the parent node (`KEY-seq`) for the new task. */
  parent?: string;
  /** Link mode: an EXISTING work node (`KEY-seq`) to record as spawned (no create). */
  link?: string;
  // Create-task args (inherited by the spawned task; title/desc default from the seed).
  title?: string;
  description?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  tags?: string[];
};

/**
 * `promote KEY-sN` — germinate the seed into work (MMR-245). Create mode
 * (`--parent`) creates a task via `createTask` (inheriting its guarantees) with
 * the seed's title/description as defaults; link mode (`--link`) records an
 * existing node as spawned without creating. Either way it appends the spawned
 * provenance link and, on the FIRST promote, transitions `new → promoted`
 * (repeatable while promoted). `--parent` and `--link` are mutually exclusive.
 * Returns the updated seed plus the created id (create mode only).
 */
export async function promoteSeed(
  store: Store,
  id: string,
  input: PromoteSeedInput,
): Promise<{ seed: SeedView; created?: string }> {
  const ref = parseSeedRef(id);
  if (ref === null) {
    throw notFound(`${id} is not a seed id`, 'seed ids look like KEY-sN');
  }
  if (input.parent !== undefined && input.link !== undefined) {
    throw validation('promote takes --parent (create) or --link (record existing), not both');
  }
  const rec = await store.seeds.load(ref.key, ref.seq, { content: true });
  if (rec === undefined) {
    throw notFound(`no seed ${id}`);
  }
  if (isTerminalSeed(rec.lifecycle)) {
    throw validation(
      `seed ${id} is ${rec.lifecycle} — a terminal seed cannot be promoted`,
      'promote applies to a new or promoted seed',
    );
  }

  const set = deriveSet(await store.loadWorkingSet());
  let createdStem: string;
  let created: string | undefined;
  if (input.link !== undefined) {
    const node = findNodeInSet(set, input.link);
    if (node === undefined || set.archivedProjects.has(node.project_id)) {
      throw notFound(`${input.link} doesn't exist`, 'see what exists: mimir list -f ids');
    }
    const stem = renderNodeIdFromSet(set, node);
    if (stem === null) {
      throw validation(`${input.link} could not be rendered as a node id`);
    }
    createdStem = stem;
  } else if (input.parent !== undefined) {
    const parent = findNodeInSet(set, input.parent);
    if (parent === undefined || set.archivedProjects.has(parent.project_id)) {
      throw notFound(`${input.parent} doesn't exist`, 'a task parent is a phase or initiative');
    }
    const key = set.keyByProjectId.get(parent.project_id);
    if (key === undefined) {
      throw validation(`${input.parent} has no resolvable project`);
    }
    const task = await createTask(store, {
      description: input.description ?? rec.description ?? null,
      parentId: parent.id,
      priority: input.priority,
      size: input.size,
      tags: input.tags,
      title: input.title ?? rec.title,
    });
    createdStem = renderId({ key, seq: task.seq });
    created = createdStem;
  } else {
    throw validation(
      'promote requires --parent <node> (create) or --link <KEY-seq> (record existing)',
    );
  }

  await store.seeds.appendSpawned(ref.key, ref.seq, createdStem);
  // First promote crosses new → promoted; further germination just appends links.
  if (rec.lifecycle === 'new') {
    await store.seeds.transition(ref.key, ref.seq, 'promoted', `promoted — spawned ${createdStem}`);
  }
  return { created, seed: await getSeed(store, id, { content: true }) };
}

/**
 * `reject` / `resolve KEY-sN "<reason>"` — the terminal transitions (MMR-245).
 * Both are reachable from `new` or `promoted`; the reason is required and rides
 * the `## History` record. The store's lifecycle machine enforces the legal edge
 * and terminal-freeze.
 */
export async function transitionSeed(
  store: Store,
  id: string,
  to: 'resolved' | 'rejected',
  reason: string,
): Promise<SeedView> {
  const ref = parseSeedRef(id);
  if (ref === null) {
    throw notFound(`${id} is not a seed id`, 'seed ids look like KEY-sN');
  }
  if (reason.trim() === '') {
    throw validation(`${to === 'rejected' ? 'reject' : 'resolve'} requires a reason`);
  }
  await store.seeds.transition(ref.key, ref.seq, to, reason);
  return getSeed(store, id, { content: true });
}

export type UpdateSeedFields = {
  title?: string;
  kind?: SeedKind;
  /** The `## Seed Description` prose; `null` clears it. */
  description?: string | null;
};

/**
 * `update KEY-sN` — patch a LIVE seed's title/kind/description (MMR-245). The
 * store refuses a terminal (frozen) seed and an absent one; `requester`/`spawned`
 * are verb-owned and never hand-patched here.
 */
export async function updateSeed(
  store: Store,
  id: string,
  fields: UpdateSeedFields,
): Promise<SeedView> {
  const ref = parseSeedRef(id);
  if (ref === null) {
    throw notFound(`${id} is not a seed id`, 'seed ids look like KEY-sN');
  }
  await store.seeds.patch(ref.key, ref.seq, fields);
  return getSeed(store, id, { content: true });
}
