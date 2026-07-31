import { CHEAP_FACETS } from '@mimir/contract';
import type {
  ArtifactDetail,
  ArtifactSummary,
  FacetName,
  FieldFilter,
  NodeView,
  OverviewAttentionTask,
  OverviewAwaitingTask,
  OverviewDirection,
  OverviewReport,
  OverviewSeed,
  OverviewSessions,
  Priority,
  SetResult,
  Size,
  StatusSelector,
  StatusView,
  StatusWord,
  ValueWarning,
  VerdictSelector,
} from '@mimir/contract';

import type { ArtifactListQuery } from '../artifacts/store';
import { laneOf } from '../attention';
import type { DerivationSet } from '../derive';
import {
  deriveSet,
  findNodeInSet,
  isTerminalWord,
  nodeStatusWord,
  statusOf,
  statusOfProject,
} from '../derive';
import { notFound, projectNotFound, validation } from '../errors';
import { parseIdentity, renderArtifactRef, renderSeedRef } from '../ids';
import type { Node } from '../model';
import { isAwaiting, isBlocking, isOrphaned, isReady, isStale } from '../predicates';
import { compileFilters } from '../query';
import type { QueryRow } from '../query';
import { deriveLede } from '../seeds/lede';
import type { Store } from '../store';
import type { SessionRow } from './sessions';
import { SESSION_SUMMARY_TAG, groupSessionRows, joinSessionSummaries } from './sessions';
import { buildArtifactDetail, buildAwaitingOn, buildNodeView, buildProjectView } from './view';

/**
 * The intent layer — the read surface both the CLI and MCP render. Commands
 * differ only in *how they identify rows* (predicate vs. identity); everything
 * downstream is one projection contract (output-contract reference).
 *
 * Set selections (`next`, `list`) read through the coarse `Store` seam (ADR
 * 0016 Phase 0): one working-set projection, selection and ordering in
 * memory. Identity selections (`get`, `status_of`) resolve their target via
 * point reads, then derive over one working-set snapshot of their own —
 * derivation needs arbitrary graph reach (rollups, cross-project prereqs), so
 * the set IS the right input even for one row; O(views) counts this as one view.
 */

/** Resolve a scope `KEY` against the working set (an archived project resolves — its rows are hidden downstream). */
function resolveScope(set: DerivationSet, key: string): string {
  const project = set.ws.projects.find((p) => p.key === key);
  if (project === undefined) {
    throw projectNotFound(key);
  }
  return project.key;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** ASCII-only lowering (non-ASCII left untouched). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Compiles the SQL path's `lower(title) LIKE '%' || q || '%'` to an exact
 * regex equivalent — `%`/`_` act as wildcards inside `q` (LIKE passthrough).
 * The `u` flag makes `[\s\S]` consume a full code point, matching LIKE's
 * `_`-is-one-character semantics for astral characters (emoji).
 */
function likeMatcher(loweredQ: string): (title: string) => boolean {
  // `%`/`_` are not regex specials, so they survive escaping and substitute cleanly.
  const pattern = escapeRegExp(loweredQ)
    .replaceAll('%', String.raw`[\s\S]*`)
    .replaceAll('_', String.raw`[\s\S]`);
  const re = new RegExp(pattern, 'u');
  return (title) => re.test(asciiLower(title));
}

function cmpStr(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** A node's project KEY — identity and the portable grouping key. */
function projectKey(_set: DerivationSet, n: Node): string {
  return n.project_id;
}

/** Board order: rank (nulls last), then (project KEY, numeric seq) — a portable,
 * numerically-correct tiebreak (seq is per-project, so KEY groups first). */
function byRankOrder(set: DerivationSet) {
  return (a: Node, b: Node): number =>
    (a.rank === null ? 1 : 0) - (b.rank === null ? 1 : 0) ||
    (a.rank ?? 0) - (b.rank ?? 0) ||
    cmpStr(projectKey(set, a), projectKey(set, b)) ||
    a.seq - b.seq;
}

/** Terminal order: completed_at (nulls last) descending, then (project KEY, seq). */
function byCompletedOrder(set: DerivationSet) {
  return (a: Node, b: Node): number => {
    const aNull = a.completed_at === null ? 1 : 0;
    const bNull = b.completed_at === null ? 1 : 0;
    if (aNull !== bNull) {
      return aNull - bNull;
    }
    if (a.completed_at !== null && b.completed_at !== null && a.completed_at !== b.completed_at) {
      return a.completed_at < b.completed_at ? 1 : -1;
    }
    return cmpStr(projectKey(set, a), projectKey(set, b)) || a.seq - b.seq;
  };
}

/** `next` order: project KEY, then rank, then numeric seq. */
function byProjectRank(set: DerivationSet) {
  return (a: Node, b: Node): number =>
    cmpStr(projectKey(set, a), projectKey(set, b)) ||
    (a.rank ?? 0) - (b.rank ?? 0) ||
    a.seq - b.seq;
}

function setResult(
  items: NodeView[],
  total: number,
  issueCount: number | undefined,
  startsAt = 0,
): SetResult<NodeView> {
  return { issueCount, items, returned: items.length, startsAt, total };
}

/** Does this Status word fall inside the selected universe? */
function inUniverse(word: StatusWord, selector: StatusSelector): boolean {
  if (selector === 'all') {
    return true;
  }
  if (selector === 'live') {
    return !isTerminalWord(word);
  }
  if (selector === 'terminal') {
    return isTerminalWord(word);
  }
  return word === selector;
}

/** Does the selector's universe include any live (non-terminal) words? */
function coversLive(selector: StatusSelector): boolean {
  if (selector === 'live' || selector === 'all') {
    return true;
  }
  if (selector === 'terminal' || selector === 'archived') {
    return false;
  }
  return !isTerminalWord(selector);
}

/** Does the selector's universe include any terminal words? */
function coversTerminal(selector: StatusSelector): boolean {
  if (selector === 'terminal' || selector === 'all') {
    return true;
  }
  if (selector === 'live' || selector === 'archived') {
    return false;
  }
  return isTerminalWord(selector);
}

/** AND every `--is` / `--not-is` verdict against a node. */
function passesVerdicts(
  set: DerivationSet,
  node: Node,
  verdicts: readonly VerdictSelector[],
): boolean {
  for (const { verdict, negate } of verdicts) {
    let holds: boolean;
    if (verdict === 'stale') {
      holds = isStale(set, node);
    } else if (verdict === 'blocking') {
      holds = isBlocking(set, node);
    } else {
      holds = isOrphaned(set, node);
    }
    if (holds === negate) {
      return false;
    }
  }
  return true;
}

/**
 * Assemble a node's filter-evaluation row — the projection's bare values
 * under their external names, all served from the working set. `needed`
 * keeps unread values off the row (parity with the filter compiler's
 * contract; every source is in memory now, so it is thrift, not necessity).
 */
function toQueryRow(
  set: DerivationSet,
  node: Node,
  word: StatusWord,
  needed: ReadonlySet<string>,
): QueryRow {
  const values: Record<string, string | null> = {
    // The resume handles (branch/harness/host/session, MMR-320) are ordinary
    // queryable strings — `--eq session:…` / `--has branch` is how a caller finds
    // the work a given session or machine still holds.
    branch: node.branch,
    completed_at: node.completed_at,
    created_at: node.created_at,
    // No `description`: it left the query surface (MMR-162) — it is body prose,
    // and `node.description` is null on the Norn working set, so filtering it
    // would silently diverge. `summary` (frontmatter) is the queryable field.
    external_ref: node.external_ref,
    harness: node.harness,
    hold: node.hold,
    hold_reason: node.hold_reason,
    host: node.host,
    lifecycle: node.lifecycle,
    priority: node.priority,
    session: node.session,
    size: node.size,
    status: word,
    summary: node.summary,
    target: node.target,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
    upstream: node.upstream,
  };
  if (needed.has('id')) {
    values.id = node.id;
  }
  if (needed.has('parent')) {
    const parent = node.parent_id === null ? undefined : set.nodeById.get(node.parent_id);
    values.parent = parent?.id ?? null;
  }
  let tags: readonly string[] = [];
  if (needed.has('tag')) {
    tags = (set.ws.nodeTags.get(node.id) ?? []).map((t) => t.tag);
  }
  return { tags, values };
}

const emptyResult = (warnings: ValueWarning[]): SetResult<NodeView> => ({
  items: [],
  returned: 0,
  startsAt: 0,
  total: 0,
  warnings,
});

export type NextOptions = {
  scope?: string;
  priority?: Priority;
  size?: Size;
  verdicts?: VerdictSelector[];
  filters?: FieldFilter[];
  limit?: number;
  facets?: readonly FacetName[];
};

/**
 * `next` — the headline "what's next": **ready** tasks (todo, un-held, every
 * dependency settled) in **rank** order. Scoped to a project if given; ordered
 * (project, rank) otherwise. `priority`/`size`/operators filter, never sort
 * (ADR 0007); the universe is fixed (ready *is* next's selection).
 */
export async function nextTasks(
  store: Store,
  opts: NextOptions = {},
): Promise<SetResult<NodeView>> {
  const compiled = compileFilters(opts.filters ?? []);
  if (compiled.warnings.length > 0) {
    return emptyResult(compiled.warnings);
  }
  const set = deriveSet(await store.loadWorkingSet());
  const scopeId = opts.scope === undefined ? undefined : resolveScope(set, opts.scope);
  const candidates = set.ws.nodes
    .filter(
      (n) =>
        n.type === 'task' &&
        n.lifecycle === 'todo' &&
        n.hold === 'none' &&
        n.rank !== null &&
        !set.archivedProjects.has(n.project_id) &&
        (scopeId === undefined || n.project_id === scopeId) &&
        (opts.priority === undefined || n.priority === opts.priority) &&
        (opts.size === undefined || n.size === opts.size),
    )
    .toSorted(byProjectRank(set));

  const verdicts = opts.verdicts ?? [];
  const ready: Node[] = [];
  for (const row of candidates) {
    if (!isReady(set, row)) {
      continue;
    }
    if (!passesVerdicts(set, row, verdicts)) {
      continue;
    }
    if (!compiled.test(toQueryRow(set, row, 'ready', compiled.needed))) {
      continue;
    }
    ready.push(row);
  }
  const limited = opts.limit !== undefined ? ready.slice(0, opts.limit) : ready;
  const facets = new Set(opts.facets);
  const items = await Promise.all(
    limited.map((node) => buildNodeView(store.bodySections, store.artifacts, set, node, facets)),
  );
  return setResult(items, ready.length, set.ws.issueCount);
}

export type ListOptions = {
  scope?: string;
  /** The selection universe (MMR-33). Default `live`. An array ORs the
   * selectors into one union universe (MMR-228 — the tasks browser's
   * multi-status filter). */
  status?: StatusSelector | readonly StatusSelector[];
  verdicts?: VerdictSelector[];
  filters?: FieldFilter[];
  priority?: Priority;
  size?: Size;
  tag?: string;
  /** Case-insensitive substring over title (MMR-78; LIKE, FTS5 deferred). */
  q?: string;
  limit?: number;
  facets?: readonly FacetName[];
};

/**
 * `list` — broad selection (MMR-33): `--status` picks the universe (the
 * closed status words + `live`/`terminal`/`all` unions), `--is`/`--not-is`
 * verdicts and field operators filter within it, all AND-composed. Tasks
 * only, unless a `type` filter widens the selection to containers. Live
 * universes order by rank (nulls last); `terminal` orders by `completed_at`
 * descending (no rank outside the rankable set).
 */
export async function listNodes(
  store: Store,
  opts: ListOptions = {},
): Promise<SetResult<NodeView>> {
  const compiled = compileFilters(opts.filters ?? []);
  if (compiled.warnings.length > 0) {
    return emptyResult(compiled.warnings);
  }
  const statusOpt = opts.status ?? 'live';
  const asGiven: readonly StatusSelector[] =
    typeof statusOpt === 'string' ? [statusOpt] : statusOpt;
  const selectors: readonly StatusSelector[] = asGiven.length > 0 ? asGiven : ['live'];
  const widened = (opts.filters ?? []).some((f) => f.field === 'type');
  const anyLive = selectors.some(coversLive);
  const anyTerminal = selectors.some(coversTerminal);
  // A purely terminal selection orders by completion; anything touching the
  // live universe keeps rank order (mixed unions included — rank nulls sort last).
  const terminalOrder = anyTerminal && !anyLive;

  const set = deriveSet(await store.loadWorkingSet());
  const scopeId = opts.scope === undefined ? undefined : resolveScope(set, opts.scope);
  const matchesQ =
    opts.q === undefined || opts.q === '' ? undefined : likeMatcher(opts.q.toLowerCase());
  const rows = set.ws.nodes
    .filter((n) => {
      if (!widened) {
        if (n.type !== 'task') {
          return false;
        }
        // Task words map 1:1 onto lifecycle terminality — the coarse universe
        // cut: drop the terminality bucket no selector's universe can reach.
        const terminal = n.lifecycle === 'done' || n.lifecycle === 'abandoned';
        if (terminal ? !anyTerminal : !anyLive) {
          return false;
        }
      }
      if (scopeId !== undefined && n.project_id !== scopeId) {
        return false;
      }
      if (opts.priority !== undefined && n.priority !== opts.priority) {
        return false;
      }
      if (opts.size !== undefined && n.size !== opts.size) {
        return false;
      }
      if (
        opts.tag !== undefined &&
        !(set.ws.nodeTags.get(n.id) ?? []).some((t) => t.tag === opts.tag)
      ) {
        return false;
      }
      if (matchesQ !== undefined && !matchesQ(n.title)) {
        return false;
      }
      // Hide archived projects' subtrees (ADR 0015). The `archived` universe is a
      // project-level door handled by the transport, never reaching listNodes.
      return !set.archivedProjects.has(n.project_id);
    })
    .toSorted(terminalOrder ? byCompletedOrder(set) : byRankOrder(set));

  const verdicts = opts.verdicts ?? [];
  const matched: { node: Node; word: StatusWord }[] = [];
  for (const row of rows) {
    const word = nodeStatusWord(set, row);
    if (!selectors.some((selector) => inUniverse(word, selector))) {
      continue;
    }
    if (!passesVerdicts(set, row, verdicts)) {
      continue;
    }
    if (!compiled.test(toQueryRow(set, row, word, compiled.needed))) {
      continue;
    }
    matched.push({ node: row, word });
  }
  const limited = opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
  const facets = new Set(opts.facets);
  const items = await Promise.all(
    limited.map(({ node }) =>
      buildNodeView(store.bodySections, store.artifacts, set, node, facets),
    ),
  );
  return setResult(items, matched.length, set.ws.issueCount);
}

export type GetOptions = {
  facets?: readonly FacetName[];
};

/**
 * `get <id>` — identity selection by the full grammar (MMR-32): a node
 * (`KEY-seq`) or a whole project (bare `KEY`), as one shared projection. Full
 * record: all bare fields + cheap facets by default (`history` stays opt-in).
 * A missing target throws (non-zero exit — identity selection). Artifacts
 * (`KEY-aN`) have their own shape — see {@link getArtifact}.
 */
export async function getNode(store: Store, id: string, opts: GetOptions = {}): Promise<NodeView> {
  const facets = new Set<FacetName>(opts.facets ?? CHEAP_FACETS);
  const identity = parseIdentity(id);
  const set = deriveSet(await store.loadWorkingSet());
  if (identity?.kind === 'project') {
    const project = set.ws.projects.find((p) => p.key === identity.key);
    if (project === undefined || project.archived_at !== null) {
      throw projectNotFound(identity.key);
    }
    return buildProjectView(store.bodySections, store.artifacts, set, project, facets);
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  if (identity?.kind === 'seed') {
    // A seed id is a grooming record — reject it as a kind-error, not a fake
    // `doesn't exist`. `get KEY-sN` is served by the seed reader (MMR-245/B4).
    throw validation(
      `${id} is a seed, not a task, phase, or initiative`,
      'read it: mimir get (seed)',
    );
  }
  const node = findNodeInSet(set, id);
  if (node === undefined || set.archivedProjects.has(node.project_id)) {
    throw notFound(`${id} doesn't exist`);
  }
  return buildNodeView(store.bodySections, store.artifacts, set, node, facets);
}

/**
 * `get KEY-aN` — identity selection of an artifact: metadata + links + tags
 * (MMR-32); the frozen body via the opt-in `content` column (MMR-34).
 */
export async function getArtifact(
  store: Store,
  id: string,
  opts: { content?: boolean } = {},
): Promise<ArtifactDetail> {
  const identity = parseIdentity(id);
  if (identity?.kind !== 'artifact') {
    throw notFound(`${id} is not an artifact id`, 'artifact ids look like KEY-aN');
  }
  // The artifact's owning project must exist and be active (ADR 0015 hiding).
  const { projects } = await store.loadWorkingSet();
  const project = projects.find((p) => p.key === identity.key);
  if (project === undefined || project.archived_at !== null) {
    throw notFound(`${id} doesn't exist`);
  }
  const record = await store.artifacts.load(identity.key, identity.seq, opts);
  if (record === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return buildArtifactDetail(record);
}

/**
 * `status_of <id>` — a rollup distribution and its single `interpret` label,
 * for a node (`KEY-seq`) or a whole project (bare `KEY`, MMR-32).
 */
export async function statusOfNode(store: Store, id: string): Promise<StatusView> {
  const identity = parseIdentity(id);
  const set = deriveSet(await store.loadWorkingSet());
  if (identity?.kind === 'project') {
    const project = set.ws.projects.find((p) => p.key === identity.key);
    if (project === undefined || set.archivedProjects.has(project.key)) {
      throw projectNotFound(identity.key);
    }
    const { status, distribution } = statusOfProject(set, project.key);
    return { distribution, id: identity.key, status, type: 'project' };
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  if (identity?.kind === 'seed') {
    // A seed id is a grooming record — reject it as a kind-error, not a fake
    // `doesn't exist`. `get KEY-sN` is served by the seed reader (MMR-245/B4).
    throw validation(
      `${id} is a seed, not a task, phase, or initiative`,
      'read it: mimir get (seed)',
    );
  }
  const node = findNodeInSet(set, id);
  if (node === undefined || set.archivedProjects.has(node.project_id)) {
    throw notFound(`${id} doesn't exist`);
  }
  const { status, distribution } = statusOf(set, node);
  return { distribution, id: node.id, status, type: node.type };
}

/** The section cap — the head of each queue and listing, per ADR 0024's orientation
 * surface (the tails live one `mimir list`/`mimir next`/`mimir artifacts` away).
 * In flight is uncapped. */
const OVERVIEW_CAP = 5;

/**
 * How many of the project's tasks the recent-sessions layer reads `## History`
 * for (MMR-322) — the read-amplification bound. History is a body section: a
 * per-task document read that a big board would otherwise multiply by every task
 * it holds, for a section that shows five entries. The scan takes the most
 * recently touched tasks first, which is exactly the population the newest
 * sessions moved, so the bound costs coverage only for sessions already far
 * below the cap.
 */
const SESSION_SCAN_CAP = 20;

/** How many `session_summary` artifacts the join considers (MMR-322) — newest-first,
 * deep enough to cover the capped entries plus their orphans without paging the
 * project's whole retrospective shelf. */
const SESSION_SUMMARY_CAP = 20;

export type OverviewOptions = {
  /** Reference time for the stale hygiene count (ISO-ms-Z); defaults to now — injectable for tests. */
  asOf?: string;
};

/**
 * The recent-sessions section (MMR-322, ADR 0026 Decision 4).
 *
 * **Read path.** The mechanical layer comes from `## History` over the working
 * set overview already holds — NOT from the {@link
 * import('../transitions/store').TransitionsFeed}. The feed is whole-vault by
 * construction (no scope or `since` push-down: it re-fans, validates, and parses
 * every node document in the vault on each call), so routing a one-project
 * orientation surface through it would read every other project's board to
 * answer a question about this one. The {@link SESSION_SCAN_CAP} most recently
 * touched tasks in scope are read in ONE batched
 * {@link import('../body-sections/store').BodySectionStore.readSectionsMany}
 * call — the backend client serializes its calls, so a per-task fan-out would be
 * 20 sequential IPC hops on the session-boot path however it were wrapped.
 *
 * **What the section can and cannot see.** Two bounds shape the result, and
 * neither is recoverable without unbounded reads — which is why the section
 * reports what it saw rather than a true total (see {@link
 * import('@mimir/contract').OverviewSessions}):
 *
 * - a session whose tasks have all fallen below the scan window is invisible.
 *   `updated_at` moves on ANY write, not just a transition, so a busy board can
 *   evict a session-bearing task without that session having ended;
 * - only the boundaries that ECHO a session handle are visible at all — `start`
 *   (the claim) and the clearing verbs (`done`/`abandon`, `park`/`block`).
 *   `submit`/`return`/`reopen`/`unpark`/`unblock` move no handle and echo none
 *   (MMR-320), so a session that only reviewed work leaves no mechanical trace;
 *   its retrospective artifact, if it wrote one, still surfaces as its own entry.
 */
async function recentSessions(
  store: Store,
  scopeKey: string,
  tasks: readonly Node[],
): Promise<OverviewSessions> {
  const scanned = tasks
    .toSorted((a, b) => -cmpStr(a.updated_at, b.updated_at))
    .slice(0, SESSION_SCAN_CAP);

  const rows: SessionRow[] = [];
  const histories = await store.bodySections.readSectionsMany(
    scanned.map((node) => node.id),
    { history: true },
  );
  for (const node of scanned) {
    for (const entry of histories.get(node.id)?.history ?? []) {
      // A row that moved no handle carries no session, so it joins no group —
      // it is not "unknown session" activity, it is activity the log cannot
      // attribute. Rows written before the handles existed read the same way.
      const session = entry.handles?.session;
      if (session !== undefined && session !== '') {
        rows.push({ at: entry.at, session, task: { id: node.id, title: node.title } });
      }
    }
  }

  const summaries = await store.artifacts.list({
    limit: SESSION_SUMMARY_CAP,
    project: scopeKey,
    tag: SESSION_SUMMARY_TAG,
  });
  const entries = joinSessionSummaries(
    groupSessionRows(rows),
    summaries.items.map((record) => ({
      createdAt: record.created_at,
      id: renderArtifactRef({ key: record.key, seq: record.seq }),
      links: record.links,
      summary: record.summary,
      title: record.title,
    })),
  );
  return { entries: entries.slice(0, OVERVIEW_CAP), shown: entries.length };
}

/**
 * The direction block (MMR-322) — the owned `## Next` prose (MMR-321) of the
 * project plus of the containers parenting live work, in ONE batched section
 * read alongside the project's own.
 *
 * **Filter, then cap** — never the reverse. The section's population is the
 * DIRECT parents of every live task: in-flight or ready, the FULL ready set and
 * not the capped head. Prose is then read for all of them, and only the
 * resulting list caps.
 *
 * Both widenings exist for the same reason — a cap upstream of the prose read
 * silently drops direction. Capping the containers first lets five prose-less
 * ones hide the only container with something to say; taking parents from the
 * capped ready head instead of the whole ready set does the same thing one step
 * earlier, hiding a container whose work merely sits below rank 5. Neither costs
 * anything to widen: the candidate set is DISTINCT PARENTS of live work (a
 * handful of containers, not the board), and
 * {@link import('../body-sections/store').BodySectionStore.readSectionsMany}
 * batches the read into one round-trip however many stems it carries.
 *
 * `count` is therefore a TRUE total over that population, and only the rendered
 * list caps at {@link OVERVIEW_CAP} — the prose is uncapped in length, so a board
 * with many parallel claims would otherwise turn a boot surface into a document
 * dump. A dormant container's prose stays one `mimir get` away by design.
 */
async function directionOf(
  store: Store,
  set: DerivationSet,
  scopeKey: string,
  live: readonly Node[],
): Promise<OverviewDirection> {
  const candidates: Node[] = [];
  const seen = new Set<string>();
  for (const node of live) {
    const parent = node.parent_id === null ? undefined : set.nodeById.get(node.parent_id);
    if (parent === undefined || parent.type === 'task' || seen.has(parent.id)) {
      continue;
    }
    seen.add(parent.id);
    candidates.push(parent);
  }
  const ordered = candidates.toSorted((a, b) => a.seq - b.seq);
  // The project's stem is its bare KEY, so it rides the same batched read.
  const prose = await store.bodySections.readSectionsMany(
    [scopeKey, ...ordered.map((node) => node.id)],
    { next: true },
  );
  const withProse: OverviewDirection['containers'] = [];
  for (const node of ordered) {
    const next = prose.get(node.id)?.next;
    if (next != null && next !== '') {
      withProse.push({ id: node.id, next, title: node.title });
    }
  }
  return {
    containers: withProse.slice(0, OVERVIEW_CAP),
    count: withProse.length,
    project: prose.get(scopeKey)?.next ?? null,
  };
}

/** A needs-attention listing row (MMR-322) — the lean task plus its lane word and
 * the `going cold` modifier, both off the shared {@link laneOf} mapping. */
async function attentionRows(
  store: Store,
  set: DerivationSet,
  nodes: readonly Node[],
  asOf: string | undefined,
): Promise<OverviewAttentionTask[]> {
  return Promise.all(
    nodes.slice(0, OVERVIEW_CAP).map(async (node) => ({
      lane: laneOf(nodeStatusWord(set, node)),
      stale: isStale(set, node, { asOf }),
      task: await buildNodeView(store.bodySections, store.artifacts, set, node),
    })),
  );
}

/**
 * `overview` — one project's session-boot orientation surface (MMR-278, expanded
 * MMR-322 per ADR 0026): a flat, id-free, scope-honoring read composing the whole
 * board state into attention-ordered sections. Still ONE `loadWorkingSet` +
 * `deriveSet` over the existing pure predicates — never a `next`/`list`/`status`
 * entry point (each reloads the vault), never the doctor snapshot (the dropped
 * count is the free `WorkingSet.issueCount` byproduct, MMR-184).
 *
 * The composed sections add reads the working set cannot serve, each **bounded by
 * construction** rather than by the board's size: one seeds read (the untriaged
 * lane, triage's one-load precedent) plus one batched description read for its
 * ledes; `## History` for the {@link SESSION_SCAN_CAP} most recently touched
 * tasks; one `session_summary` artifact page; and `## Next` for the project plus
 * the deduped parents of live work.
 *
 * Counts before contents: every section carries its TRUE total even where the
 * list is capped.
 */
export async function overviewOf(
  store: Store,
  key: string,
  opts: OverviewOptions = {},
): Promise<OverviewReport> {
  const set = deriveSet(await store.loadWorkingSet());
  const scopeId = resolveScope(set, key);
  // An archived project 404s here exactly like `status`/`get`/`tree` (ADR 0015
  // hiding) — overview must never surface a shelf the siblings hide.
  if (set.archivedProjects.has(scopeId)) {
    throw projectNotFound(key);
  }
  const { status, distribution } = statusOfProject(set, scopeId);

  const tasks = set.ws.nodes.filter((n) => n.type === 'task' && n.project_id === scopeId);

  // in flight — the tasks under active hand (in_progress + under_review), uncapped.
  const inFlightNodes = tasks
    .filter((n) => {
      const word = nodeStatusWord(set, n);
      return word === 'in_progress' || word === 'under_review';
    })
    .toSorted(byRankOrder(set));

  // next — the ready-queue head (matches `next`: todo, un-held, ranked, every
  // prerequisite settled), rank order.
  const readyNodes = tasks
    .filter((n) => n.rank !== null && isReady(set, n))
    .toSorted(byRankOrder(set));

  // awaiting — dependency-gated tasks (the `awaiting` status word), rank order.
  const awaitingNodes = tasks.filter((n) => isAwaiting(set, n)).toSorted(byRankOrder(set));

  const lean = (nodes: readonly Node[]): Promise<NodeView[]> =>
    Promise.all(nodes.map((node) => buildNodeView(store.bodySections, store.artifacts, set, node)));

  const inFlightTasks = await lean(inFlightNodes);
  const nextTop = await lean(readyNodes.slice(0, OVERVIEW_CAP));
  const awaitingTasks: OverviewAwaitingTask[] = await Promise.all(
    awaitingNodes.slice(0, OVERVIEW_CAP).map(async (node) => ({
      // The upstream ids this row awaits — the deps facet's awaiting-on data (own
      // or ancestor-inherited unsettled prerequisites), reduced to ids for the clause.
      awaitingOn: buildAwaitingOn(set, node.id).map((ref) => ref.id),
      task: await buildNodeView(store.bodySections, store.artifacts, set, node),
    })),
  );

  // hygiene — the counts, each with the capped head of its own lane (MMR-322).
  // Untriaged is the one seeds read (a `new` seed IS the untriaged lane); dropped
  // is the free load byproduct (MMR-184) and stays count-only — it counts records
  // the reader dropped, which by definition are not tasks anyone can list.
  const untriagedSeeds = (await store.seeds.listForProject(scopeId)).filter(
    (seed) => seed.lifecycle === 'new',
  );
  const blockedNodes = tasks
    .filter((n) => nodeStatusWord(set, n) === 'blocked')
    .toSorted(byRankOrder(set));
  const staleNodes = tasks
    .filter((n) => isStale(set, n, { asOf: opts.asOf }))
    .toSorted(byRankOrder(set));
  const dropped = set.ws.issueCount ?? 0;

  const [direction, sessions, blockedRows, staleRows, untriagedRows] = await Promise.all([
    // The FULL ready set, not the capped head: the cap is a display bound on
    // `next`, and letting it reach back into the direction candidates would hide
    // a container's prose for no reason but its work's rank.
    directionOf(store, set, scopeId, [...inFlightNodes, ...readyNodes]),
    recentSessions(store, scopeId, tasks),
    attentionRows(store, set, blockedNodes, opts.asOf),
    attentionRows(store, set, staleNodes, opts.asOf),
    untriagedRowsOf(store, untriagedSeeds.slice(0, OVERVIEW_CAP)),
  ]);

  return {
    awaiting: { count: awaitingNodes.length, tasks: awaitingTasks },
    direction,
    hygiene: {
      blocked: blockedNodes.length,
      dropped,
      listings: { blocked: blockedRows, stale: staleRows, untriaged: untriagedRows },
      stale: staleNodes.length,
      untriaged: untriagedSeeds.length,
    },
    inFlight: { count: inFlightNodes.length, tasks: inFlightTasks },
    next: { count: readyNodes.length, tasks: nextTop },
    project: { distribution, id: scopeId, status },
    sessions,
  };
}

/**
 * The untriaged listing rows (MMR-322) — id, title, and the derived
 * `## Seed Description` lede, off ONE batched section read for the capped set
 * (the `mimir seeds` queue's own MMR-263 path). The lede is decorative, so a
 * rejected batch read degrades the rows to `lede: null` rather than failing the
 * whole orientation surface (ADR 0017).
 */
async function untriagedRowsOf(
  store: Store,
  seeds: readonly { key: string; seq: number; title: string }[],
): Promise<OverviewSeed[]> {
  const rows = seeds.map((seed) => ({
    id: renderSeedRef({ key: seed.key, seq: seed.seq }),
    lede: null as string | null,
    title: seed.title,
  }));
  if (rows.length === 0) {
    return rows;
  }
  let descriptions: ReadonlyMap<string, string | null>;
  try {
    descriptions = await store.seeds.loadDescriptions(
      seeds.map((seed) => ({ key: seed.key, seq: seed.seq })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mimir: seed description read failed — overview without previews (${message})`);
    return rows;
  }
  for (const row of rows) {
    row.lede = deriveLede(descriptions.get(row.id) ?? null);
  }
  return rows;
}

/** Portfolio artifact search options (MMR-322) — the CLI/MCP-facing shape of the
 * {@link import('../artifacts/store').ArtifactListQuery} seam query. */
export type ArtifactQueryOptions = {
  /** A project KEY, or undefined for the cross-project feed. */
  scope?: string;
  tag?: string;
  /** `YYYY-MM-DD` or a full ISO timestamp — a bare date widens to the whole day. */
  since?: string;
  before?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

/**
 * Is `value` a date bound the artifact feed can filter on — a bare
 * `YYYY-MM-DD`, or a full ISO timestamp with an optional fractional part and an
 * optional zone (`Z` or a numeric `±HH:MM` UTC offset)?
 *
 * The ONE definition every transport enforces (MMR-322), so the CLI's usage
 * refusal and the MCP tool's `validation` refusal cannot disagree about what a
 * date is. It has to be checked rather than merely normalized: the filter is a
 * lexical string compare downstream, so `since: "yesterday"` would not error —
 * it would sort against the ISO timestamps and quietly return the wrong window.
 * The shape test comes first and `Date.parse` backstops it, which rejects
 * calendar-impossible values (`2026-13-45`) the regex alone would admit.
 */
export function isFilterDate(value: string): boolean {
  return canonicalFilterInstant(value) !== null;
}

/** The shapes {@link isFilterDate} admits: a bare date, or a timestamp with an
 * optional seconds/fraction and an optional zone, `T`- or space-separated. */
const FILTER_DATE_SHAPE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An accepted filter date as the ONE canonical instant string the store compares
 * against — `YYYY-MM-DDTHH:mm:ss.sssZ` — or `null` when the value is not a
 * filter date at all. The single decision point behind both {@link isFilterDate}
 * and {@link normalizeFilterDate}, so "accepted" and "normalized" cannot drift
 * into a shape that passes validation and then compares wrong.
 *
 * Canonicalization is load-bearing because the comparison downstream is
 * **lexical** over stored `created_at` values, which are always ISO-ms UTC. Two
 * accepted forms are wrong if passed through verbatim:
 *
 * - a numeric UTC offset — `2026-07-01T23:00:00.000+02:00` is 21:00Z, but sorts
 *   as if it were 23:00, silently excluding artifacts from those two hours;
 * - the ISO space separator — `'2026-07-01 10:00'` sorts BELOW every `…T…`
 *   value for that day (`' ' < 'T'`), collapsing the bound to start-of-day.
 *
 * A zone-less timestamp is read as **UTC**, matching the bare-date bounds below;
 * `new Date` would otherwise read it as local time and shift the window by the
 * host's offset, making the same command mean different things on two machines.
 */
function canonicalFilterInstant(value: string): string | null {
  if (!FILTER_DATE_SHAPE.test(value)) {
    return null;
  }
  const separated = value.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(separated) ? separated : `${separated}Z`;
  const ms = Date.parse(zoned);
  // Backstops the shape test, which admits calendar-impossible values (`2026-13-45`).
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A filter date → the ISO-ms UTC bound the store compares against. A bare
 * `YYYY-MM-DD` widens to the requested edge of that whole day; every other
 * accepted form canonicalizes to its exact instant (see
 * {@link canonicalFilterInstant}). Shared so the CLI, MCP, and HTTP artifact
 * feeds bound a window identically.
 *
 * A value that isn't a filter date passes through untouched — every caller
 * validates first, and silently substituting a bound would be worse than the
 * empty result the raw value produces.
 */
export function normalizeFilterDate(value: string, edge: 'start' | 'end'): string {
  if (BARE_DATE.test(value)) {
    return edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }
  return canonicalFilterInstant(value) ?? value;
}

/**
 * `artifacts` — the cross-project artifact feed (MMR-52, surfaced as a verb in
 * MMR-322): a thin read-only envelope over the {@link
 * import('../artifacts/store').ArtifactStore} `list` query, newest-first,
 * metadata only (a body is `get KEY-aN --col content`). Unlike `overview` it
 * spans projects — an omitted `scope` IS the portfolio query.
 *
 * Archived projects' artifacts read as absent (ADR 0015). Archived state lives
 * with the node store, which the artifact seam must not reach into, so the
 * exclude set is resolved here off the same working-set read every other
 * intent-layer query takes.
 */
export async function listArtifacts(
  store: Store,
  opts: ArtifactQueryOptions = {},
): Promise<SetResult<ArtifactSummary>> {
  const ws = await store.loadWorkingSet();
  if (opts.scope !== undefined && !ws.projects.some((p) => p.key === opts.scope)) {
    throw projectNotFound(opts.scope);
  }
  const query: ArtifactListQuery = {
    excludeProjects: ws.projects.filter((p) => p.archived_at !== null).map((p) => p.key),
  };
  if (opts.scope !== undefined) {
    query.project = opts.scope;
  }
  if (opts.tag !== undefined) {
    query.tag = opts.tag;
  }
  if (opts.q !== undefined && opts.q !== '') {
    query.q = opts.q;
  }
  if (opts.since !== undefined) {
    query.since = normalizeFilterDate(opts.since, 'start');
  }
  if (opts.before !== undefined) {
    query.before = normalizeFilterDate(opts.before, 'end');
  }
  if (opts.limit !== undefined) {
    query.limit = opts.limit;
  }
  if (opts.offset !== undefined) {
    query.offset = opts.offset;
  }
  const result = await store.artifacts.list(query);
  const items = result.items.map((record) => {
    const summary: ArtifactSummary = {
      createdAt: record.created_at,
      id: renderArtifactRef({ key: record.key, seq: record.seq }),
      project: record.key,
      tags: record.tags,
      title: record.title,
    };
    // Optional (MMR-319): no lede, no key on the wire.
    if (record.summary !== null) {
      summary.summary = record.summary;
    }
    return summary;
  });
  return {
    issueCount: ws.issueCount,
    items,
    returned: items.length,
    startsAt: opts.offset ?? 0,
    total: result.total,
  };
}
