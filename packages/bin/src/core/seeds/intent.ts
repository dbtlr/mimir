import { SEED_KIND_VALUES } from '@mimir/contract';
import type {
  Priority,
  SeedKind,
  SeedLifecycle,
  SeedStatusSelector,
  Size,
  SeedView,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { createTask } from '../create';
import type { DerivationSet } from '../derive';
import { deriveSet, findNodeInSet, findProjectInSet, isNodeSettled } from '../derive';
import { conflict, notFound, projectNotFound, validation } from '../errors';
import { parseId, parseSeedRef, renderId, renderSeedRef } from '../ids';
import type { Node, Project } from '../model';
import type { Store } from '../store';
import { assertTitleWithinCap, splitCapture } from './capture';
import { deriveLede } from './lede';
import { isTerminalSeed } from './store';
import type { SeedRecord } from './store';

/**
 * The seed verb surface (MMR-245) — the transport-agnostic read + mutation
 * layer the CLI, MCP, and HTTP all render, paralleling the node intent layer.
 *
 * **The resolving read seam.** Every verb-facing read routes through a
 * {@link SeedResolver} + {@link resolveSeedView}, mirroring how the node reader
 * consumes `validate`'s valid subgraph (`loadNornSnapshot`): the per-record
 * store decoder stays dumb, and it is HERE that a read nulls/prunes what the
 * validator would drop — an unknown `requester` reads as `null`, a `spawned`
 * ref that resolves to no surviving work node is pruned. The resolver is
 * project-scoped (MMR-251): the single-seed reads and every write echo build it
 * from an all-projects read plus only the spawned targets' nodes — never a
 * whole-vault load — while the read still computes `readyToResolve` live (the
 * house rule: derive, never store).
 */

/** The seed queue universe (MMR-245): a lifecycle word, or the `live`/`all` unions.
 * Single-sourced in `@mimir/contract`; re-exported so `core` consumers (the three
 * transports) import it from one place. */
export type { SeedStatusSelector } from '@mimir/contract';

/** The live universe — the untriaged + in-flight seeds (the non-terminal states),
 * derived from the lifecycle machine rather than a hand-spelled union (M2). */
const isLive = (lifecycle: SeedLifecycle): boolean => !isTerminalSeed(lifecycle);

/** Narrow a raw `kind` value to the closed seed-kind enum, or `null` when it is
 * absent/non-string/foreign — the ONE narrowing every transport boundary shares
 * (CLI/MCP/HTTP), each throwing its own error type on `null` (M4). */
export function asSeedKind(value: unknown): SeedKind | null {
  return typeof value === 'string' && isMember(value, SEED_KIND_VALUES) ? value : null;
}

/**
 * The shared read context: the active project keys (an unknown `requester`
 * nulls against this) plus the derived working set (spawned refs + settledness
 * resolve against its surviving nodes). Archived projects read as absent
 * (ADR 0015), so their keys and nodes are excluded from resolution.
 *
 * **Project-scoped (MMR-251).** The single-seed reads and every write echo build
 * this from a lightweight all-projects read plus ONLY the nodes of the seed's
 * spawned targets' projects — never a whole-vault load. All projects are present
 * (the requester-null and archived-board-hiding derive over them); only the spawned
 * targets' nodes are loaded (a task settles by its own lifecycle, a container by its
 * in-project descendant rollup, so the target's project is the whole settledness
 * closure). {@link resolveSeedView} and {@link assertSeedBoardActive} read the same
 * `DerivationSet` API, so scoping is invisible to them.
 */
type SeedResolver = { projectKeys: ReadonlySet<string>; set: DerivationSet };

/** The active (non-archived) project keys — an archived board reads as absent
 * (ADR 0015), so its key is not "known" for board/requester resolution. */
function activeKeys(projects: readonly Project[]): Set<string> {
  return new Set(projects.filter((p) => p.archived_at === null).map((p) => p.key));
}

/** The distinct owning-project keys of the seeds' spawned work-node stems — the
 * projects whose nodes the resolving read must load to settle/prune the refs. A
 * non-`KEY-seq` stem contributes nothing (it resolves to no node either way). */
function spawnedTargetKeys(records: readonly Pick<SeedRecord, 'spawned'>[]): string[] {
  const keys = new Set<string>();
  for (const rec of records) {
    for (const stem of rec.spawned) {
      const ref = parseId(stem);
      if (ref !== null) {
        keys.add(ref.key);
      }
    }
  }
  return [...keys];
}

/** Assemble a resolver from an all-projects read + the (project-scoped) nodes that
 * settle/prune the spawned refs. Edges and tags are irrelevant to seed resolution
 * (settledness never consults edges), so the derived set carries none. */
function buildResolver(projects: readonly Project[], nodes: readonly Node[]): SeedResolver {
  const set = deriveSet({
    edges: [],
    nodeTags: new Map(),
    nodes,
    projectTags: new Map(),
    projects,
  });
  return { projectKeys: activeKeys(projects), set };
}

/**
 * Read a seed and render its resolved view (MMR-251), scoping the resolution to the
 * spawned targets' projects rather than the whole vault. `projects` is the
 * already-loaded all-projects read (shared with the caller's guard, so it is read
 * once per verb); an absent seed throws `not_found`. Every write verb echoes through
 * here so its output renders identically to a standalone {@link getSeed}.
 */
async function echoSeed(
  store: Store,
  ref: { key: string; seq: number },
  projects: readonly Project[],
  opts: { content?: boolean } = {},
): Promise<SeedView> {
  const rec = await store.seeds.load(ref.key, ref.seq, opts);
  if (rec === undefined) {
    throw notFound(`${renderSeedRef(ref)} doesn't exist`);
  }
  const keys = spawnedTargetKeys([rec]);
  // Presence for the scoped node read derives from the VALIDATED projects read (MMR-251),
  // never the requested spawned-target keys: a target in a missing/duplicate-key project
  // drops (missing-project) exactly as the whole-vault path drops it, so the ref prunes.
  const valid = new Set(projects.map((p) => p.key));
  const nodes = keys.length > 0 ? await store.loadNodesForProjects(keys, valid) : [];
  return resolveSeedView(rec, buildResolver(projects, nodes));
}

/**
 * The seed write-lock (ADR 0015, MMR-245): a seed whose OWN board is archived
 * refuses every mutation, mirroring the node write-lock
 * (`mutations/common.ts#assertProjectActive`) with the same `conflict` vocabulary.
 * Asserted BEFORE any store write — and, for promote, before `createTask` — so a
 * frozen board is never mutated and never orphans a task. An absent board (no
 * project doc, or one the validator's presence rule dropped) refuses too: the
 * orphan seed's FILE still point-reads fine, so without this check a write
 * would mutate — or promotion spawn work into — a board that every read path
 * treats as unknown.
 */
function assertSeedBoardActive(set: DerivationSet, key: string): void {
  const project = findProjectInSet(set, key);
  if (project === undefined) {
    throw projectNotFound(key);
  }
  if (project.archived_at !== null) {
    throw conflict(
      `project ${key} is archived — no changes are allowed`,
      `unarchive it first: mimir unarchive ${key}`,
    );
  }
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
  // Each spawned ref → its work node, keeping only those that resolve. A ref whose
  // node was deleted (truly dangling) drops from both display and readiness.
  const resolved = rec.spawned
    .map((stem) => ({ node: findNodeInSet(r.set, stem), stem }))
    .filter((x): x is { node: NonNullable<typeof x.node>; stem: string } => x.node !== undefined);
  // DISPLAY facet: a ref whose board is since-archived reads as absent (ADR 0015),
  // so it is hidden from `spawned[]` — but it still counts for readiness below.
  const spawned = resolved
    .filter((x) => !r.set.archivedProjects.has(x.node.project_id))
    .map((x) => x.stem);
  // READINESS is derived over the UNPRUNED survivors: an archived-board node is
  // settled (archiving is a stronger "this is over" than done — ADR 0015
  // Refinement, mirroring hasUnsettledPrereq), so spawned work in a since-archived
  // board never pins readyToResolve false forever, and readiness reverts on unarchive.
  const readyToResolve =
    rec.lifecycle === 'promoted' &&
    resolved.length > 0 &&
    resolved.every(
      (x) => r.set.archivedProjects.has(x.node.project_id) || isNodeSettled(r.set, x.node),
    );
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
  /** The target board whose queue to read; absent (or the literal `'all'`) = every
   * active project. Honoring `'all'` at the seam is what lets all three transports
   * converge on one mapping (MMR-245/B5b). */
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
  return (await listSeedsResolved(store, opts)).views;
}

/**
 * The queue read PLUS the working set it resolved over (MMR-251/D4) — so the triage
 * pass reuses ONE load for both its live-seed checks (this listing) and its own
 * board-task check, rather than each deriving a whole-vault set. Unlike the
 * single-seed reads, the listing stays a whole-vault load: it is inherently
 * board-wide and its set is what triage's check (c) reads the board's own tasks from.
 */
export async function listSeedsResolved(
  store: Store,
  opts: ListSeedsOptions = {},
): Promise<{ views: SeedView[]; set: DerivationSet }> {
  const set = deriveSet(await store.loadWorkingSet());
  const r: SeedResolver = { projectKeys: activeKeys(set.ws.projects), set };
  // `'all'` is the every-active-board selector, equivalent to omitting `project` —
  // handled HERE so CLI `-p all`, HTTP `?project=all`, and MCP converge (B5b).
  const project = opts.project === 'all' ? undefined : opts.project;
  if (project !== undefined && !r.projectKeys.has(project)) {
    throw projectNotFound(project);
  }
  // Bound: one project's inventory. Unbound: ONE whole-vault find (E1), filtered to
  // ACTIVE boards (archived-parity — an archived board's seeds read as absent, ADR 0015).
  const records: SeedRecord[] =
    project !== undefined
      ? await store.seeds.listForProject(project)
      : (await store.seeds.listAll()).filter((rec) => r.projectKeys.has(rec.key));
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
  // Oldest-first FIFO by created_at; the tiebreak is project key then NUMERIC seq
  // (matching the node queues' `cmpStr(projectKey) || a.seq - b.seq` shape) so a
  // same-timestamp KEY-s10 sorts after KEY-s2, not before it lexically. desc reverses.
  views.sort(
    (a, b) =>
      cmp(a.createdAt, b.createdAt) ||
      cmp(a.project, b.project) ||
      (parseSeedRef(a.id)?.seq ?? 0) - (parseSeedRef(b.id)?.seq ?? 0),
  );
  if (opts.sort === 'desc') {
    views.reverse();
  }
  // Derive-at-read lede (MMR-263): batch-read the `## Seed Description` for the
  // LIVE seeds in ONE native section read, then derive the bounded lede server-side
  // (the single source every transport renders). Settled rows carry no lede — their
  // body comes on demand from the detail read. Nothing is stored.
  await attachLede(store, views);
  return { set, views };
}

/** Attach the derived lede to the LIVE views in `views` (mutated in place) from a
 * single batched section read (MMR-263). A no-op when no view is live.
 *
 * The lede is decorative, so a REJECTED batch read (a transport-level fault —
 * per-document corruption already degrades inside the store) must not abort the
 * queue: the live rows degrade to `lede: null` and the fault is noted on stderr —
 * the one channel every transport shares (CLI terminal, serve daemon log, MCP
 * server stderr) without a wire change — so the degradation is diagnosable, not
 * silent (ADR 0017's diagnosability rule). */
async function attachLede(store: Store, views: SeedView[]): Promise<void> {
  const live = views.filter((v) => isLive(v.lifecycle));
  const refs = live
    .map((v) => parseSeedRef(v.id))
    .filter((ref): ref is { key: string; seq: number } => ref !== null);
  if (refs.length === 0) {
    return;
  }
  let descriptions: ReadonlyMap<string, string | null>;
  try {
    descriptions = await store.seeds.loadDescriptions(refs);
  } catch (error) {
    for (const view of live) {
      view.lede = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mimir: seed description read failed — listing without previews (${message})`);
    return;
  }
  for (const view of live) {
    view.lede = deriveLede(descriptions.get(view.id) ?? null);
  }
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
  // Project-scoped (MMR-251): the lightweight all-projects read gates the board,
  // then the echo loads only the seed's spawned targets — no whole-vault load.
  const projects = await store.loadProjects();
  if (!activeKeys(projects).has(ref.key)) {
    throw notFound(`${id} doesn't exist`);
  }
  return echoSeed(store, ref, projects, opts);
}

export type FileSeedInput = {
  /** The target project (the board the seed is filed against). */
  project: string;
  /** The capture blob (MMR-263): the first line is the title, the rest is the body
   * (split at the first newline). A single line is a title-only capture. */
  title: string;
  kind: SeedKind;
  /** Explicit prose for the `## Seed Description` body section — wins over the
   * capture blob's split body when provided (never frontmatter). */
  description?: string | null;
  /** Requester-side project key; `null` = self-filed at the target board. */
  requester?: string | null;
};

/**
 * `seed` — file a seed (MMR-245). The target project must be active; a
 * non-`null` requester must name a known project. Echoes the created record.
 */
export async function fileSeed(store: Store, input: FileSeedInput): Promise<SeedView> {
  // One-blob capture grammar (MMR-263): the first line is the title, the rest is
  // the body; an explicit description wins over the split. The hard title cap is
  // the forcing function that keeps prose out of the title.
  const { title, description } = splitCapture(input.title, input.description);
  if (title === '') {
    throw validation('a seed requires a title');
  }
  assertTitleWithinCap(title);
  // Project-scoped guard (MMR-251): the lightweight all-projects read is all the
  // target/requester active-checks need — a fresh seed spawns nothing.
  const projects = await store.loadProjects();
  const keys = activeKeys(projects);
  if (!keys.has(input.project)) {
    throw projectNotFound(input.project);
  }
  // Coerce '' → null up front so an empty requester can NEVER bypass the
  // known-project guard nor write an empty `[[]]` wikilink (B5c); it self-files.
  const requester = input.requester == null || input.requester === '' ? null : input.requester;
  if (requester !== null && !keys.has(requester)) {
    throw validation(
      `requester ${requester} is not a known project`,
      'the requester is a board key (KEY); omit it to self-file',
    );
  }
  // `create` returns the held record IN FULL (MMR-251/MMR-196): a fresh seed adds no
  // work node and changes no project, so the projects read still resolves the echo —
  // no read-back of the seed just written, no whole-vault load.
  const created = await store.seeds.create({
    description,
    key: input.project,
    kind: input.kind,
    requester,
    title,
  });
  return resolveSeedView(created, buildResolver(projects, []));
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
 * Returns the updated seed, the created id (create mode only), and
 * `spawnedId` — the task a composer wants (the created task in `--parent`
 * mode, the linked id in `--link` mode; MMR-259). Every promote spawns or
 * links exactly one, so `spawnedId` is never undefined.
 */
export async function promoteSeed(
  store: Store,
  id: string,
  input: PromoteSeedInput,
): Promise<{ seed: SeedView; created?: string; spawnedId: string }> {
  const ref = parseSeedRef(id);
  if (ref === null) {
    throw notFound(`${id} is not a seed id`, 'seed ids look like KEY-sN');
  }
  if (input.parent !== undefined && input.link !== undefined) {
    throw validation('promote takes --parent (create) or --link (record existing), not both');
  }
  const rec = await store.seeds.load(ref.key, ref.seq, { content: true });
  if (rec === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  if (isTerminalSeed(rec.lifecycle)) {
    throw validation(
      `seed ${id} is ${rec.lifecycle} — a terminal seed cannot be promoted`,
      'promote applies to a new or promoted seed',
    );
  }

  // The mid-promote whole-vault load resolves an ARBITRARY `--parent`/`--link` node
  // (any board), so it stays whole-vault; the echo reuses it (below) rather than
  // paying a second find.
  const ws = await store.loadWorkingSet();
  const set = deriveSet(ws);
  // Assert the seed's OWN board is active BEFORE createTask — a promote on an
  // archived board must create nothing and mutate nothing (ADR 0015, B1a).
  assertSeedBoardActive(set, ref.key);
  let createdStem: string;
  let created: string | undefined;
  // The just-spawned task post-dates the mid-promote load, so it is stitched into
  // the echo set below (create mode only); link mode targets a node already in `set`.
  let createdNode: Node | undefined;
  if (input.link !== undefined) {
    const node = findNodeInSet(set, input.link);
    if (node === undefined || set.archivedProjects.has(node.project_id)) {
      throw notFound(`${input.link} doesn't exist`, 'see what exists: mimir list -f ids');
    }
    createdStem = node.id;
  } else if (input.parent !== undefined) {
    const parent = findNodeInSet(set, input.parent);
    if (parent === undefined || set.archivedProjects.has(parent.project_id)) {
      throw notFound(`${input.parent} doesn't exist`, 'a task parent is a phase or initiative');
    }
    const key = parent.project_id;
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
    createdNode = { ...task, id: createdStem };
  } else {
    throw validation(
      'promote requires --parent <node> (create) or --link <KEY-seq> (record existing)',
    );
  }

  // ONE atomic seed write from ONE load: append the spawned link, cross
  // new → promoted (first promote only), stamp updated_at, append the History
  // record — a single norn plan, so the task can never be created without the
  // seed reflecting it (cross-DOCUMENT atomicity with createTask is impossible
  // per the norn per-document limit; ADR 0016/NRN-107). Idempotent: a re-run with
  // the stem already linked and the seed already promoted is a no-op, so a retried
  // `--parent`/`--link` cannot double-record (B2).
  await store.seeds.germinate(ref.key, ref.seq, createdStem);
  // Echo by reusing the mid-promote load (MMR-251/D2): resolution is project-scoped,
  // so the whole-vault set already resolves every spawned ref; create mode just
  // stitches in the task it spawned. No second whole-vault find. Only the now-promoted
  // seed record is re-read (its lifecycle/spawned/updated_at changed).
  const echoSet =
    createdNode === undefined ? set : deriveSet({ ...ws, nodes: [...ws.nodes, createdNode] });
  const echoResolver: SeedResolver = {
    projectKeys: activeKeys(ws.projects),
    set: echoSet,
  };
  const post = await store.seeds.load(ref.key, ref.seq, { content: true });
  if (post === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return { created, seed: resolveSeedView(post, echoResolver), spawnedId: createdStem };
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
  // One projects read serves the board-active guard AND the echo (MMR-251): no
  // whole-vault load for either, and no second read for the echo.
  const projects = await store.loadProjects();
  assertSeedBoardActive(buildResolver(projects, []).set, ref.key);
  await store.seeds.transition(ref.key, ref.seq, to, reason);
  return echoSeed(store, ref, projects, { content: true });
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
  // `update --title` inherits the capture title cap (MMR-263) — the same forcing
  // function, so a title can never grow past the cap after the fact.
  if (fields.title !== undefined) {
    assertTitleWithinCap(fields.title);
  }
  // One projects read serves the board-active guard AND the echo (MMR-251).
  const projects = await store.loadProjects();
  assertSeedBoardActive(buildResolver(projects, []).set, ref.key);
  await store.seeds.patch(ref.key, ref.seq, fields);
  return echoSeed(store, ref, projects, { content: true });
}
