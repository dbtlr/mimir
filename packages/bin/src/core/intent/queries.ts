import { CHEAP_FACETS } from '@mimir/contract';
import type {
  ArtifactDetail,
  FacetName,
  FieldFilter,
  NodeView,
  Priority,
  SetResult,
  Size,
  StatusSelector,
  StatusView,
  StatusWord,
  ValueWarning,
  VerdictSelector,
} from '@mimir/contract';

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
import { parseIdentity } from '../ids';
import type { Node } from '../model';
import { isBlocking, isOrphaned, isReady, isStale } from '../predicates';
import { compileFilters } from '../query';
import type { QueryRow } from '../query';
import type { Store } from '../store';
import { buildArtifactDetail, buildNodeView, buildProjectView } from './view';

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
    completed_at: node.completed_at,
    created_at: node.created_at,
    // No `description`: it left the query surface (MMR-162) — it is body prose,
    // and `node.description` is null on the Norn working set, so filtering it
    // would silently diverge. `summary` (frontmatter) is the queryable field.
    external_ref: node.external_ref,
    hold: node.hold,
    hold_reason: node.hold_reason,
    lifecycle: node.lifecycle,
    priority: node.priority,
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
    return buildProjectView(store.artifacts, set, project, facets);
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
    throw notFound(`no artifact ${id}`);
  }
  const record = await store.artifacts.load(identity.key, identity.seq, opts);
  if (record === undefined) {
    throw notFound(`no artifact ${id}`);
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
