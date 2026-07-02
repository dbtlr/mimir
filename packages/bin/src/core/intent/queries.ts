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

import type { Db } from '../context';
import { isTerminalWord, nodeStatusWord, statusOf, statusOfProject } from '../derive';
import { notFound, projectNotFound, validation } from '../errors';
import { parseIdentity, renderId } from '../ids';
import { findArtifactByRef, findNodeByRef, isProjectArchived, renderNodeId } from '../lookup';
import type { Node } from '../model';
import { isBlocking, isOrphaned, isReady, isStale } from '../predicates';
import { compileFilters } from '../query';
import type { QueryRow } from '../query';
import type { Store, WorkingSet } from '../store';
import { buildArtifactDetail, buildNodeView, buildProjectView } from './view';

/**
 * The intent layer — the read surface both the CLI and MCP render. Commands
 * differ only in *how they identify rows* (predicate vs. identity); everything
 * downstream is one projection contract (output-contract reference).
 *
 * Set selections (`next`, `list`) read through the coarse `Store` seam (ADR
 * 0016 Phase 0): one working-set projection, selection and ordering in
 * memory. Identity selections (`get`, `status_of`) stay point reads — loading
 * the whole store to fetch one row would invert the O(views) rule.
 */

/** The working set plus the lookup indexes selection needs. */
type WsIndex = {
  ws: WorkingSet;
  nodeById: ReadonlyMap<number, Node>;
  keyByProjectId: ReadonlyMap<number, string>;
  /** Archived project ids — their subtrees read as absent (ADR 0015). */
  archived: ReadonlySet<number>;
};

function indexWorkingSet(ws: WorkingSet): WsIndex {
  return {
    archived: new Set(ws.projects.filter((p) => p.archived_at !== null).map((p) => p.id)),
    keyByProjectId: new Map(ws.projects.map((p) => [p.id, p.key])),
    nodeById: new Map(ws.nodes.map((n) => [n.id, n])),
    ws,
  };
}

/** Resolve a scope `KEY` against the working set (an archived project resolves — its rows are hidden downstream). */
function resolveScope(index: WsIndex, key: string): number {
  const project = index.ws.projects.find((p) => p.key === key);
  if (project === undefined) {
    throw projectNotFound(key);
  }
  return project.id;
}

function renderNodeIdWs(index: WsIndex, node: Node): string | null {
  const key = index.keyByProjectId.get(node.project_id);
  return key === undefined ? null : renderId({ key, seq: node.seq });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** ASCII-only lowering — parity with SQLite `lower()`, which leaves non-ASCII untouched. */
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

/** Board order: rank (nulls last), then seq — the live-universe sort. */
function byRankOrder(a: Node, b: Node): number {
  const aNull = a.rank === null ? 1 : 0;
  const bNull = b.rank === null ? 1 : 0;
  return aNull - bNull || (a.rank ?? 0) - (b.rank ?? 0) || a.seq - b.seq;
}

/** Terminal order: completed_at (nulls last) descending, then seq. */
function byCompletedOrder(a: Node, b: Node): number {
  const aNull = a.completed_at === null ? 1 : 0;
  const bNull = b.completed_at === null ? 1 : 0;
  if (aNull !== bNull) {
    return aNull - bNull;
  }
  if (a.completed_at !== null && b.completed_at !== null && a.completed_at !== b.completed_at) {
    return a.completed_at < b.completed_at ? 1 : -1;
  }
  return a.seq - b.seq;
}

/** `next` order: (project, rank), seq as the determinism tiebreak — rank is non-null inside the rankable set. */
function byProjectRank(a: Node, b: Node): number {
  return a.project_id - b.project_id || (a.rank ?? 0) - (b.rank ?? 0) || a.seq - b.seq;
}

function setResult(items: NodeView[], total: number, startsAt = 0): SetResult<NodeView> {
  return { items, returned: items.length, startsAt, total };
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

/** AND every `--is` / `--not-is` verdict against a node. */
async function passesVerdicts(
  db: Db,
  node: Node,
  verdicts: readonly VerdictSelector[],
): Promise<boolean> {
  for (const { verdict, negate } of verdicts) {
    let holds: boolean;
    if (verdict === 'stale') {
      holds = await isStale(db, node);
    } else if (verdict === 'blocking') {
      holds = await isBlocking(db, node);
    } else {
      holds = await isOrphaned(db, node);
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
  index: WsIndex,
  node: Node,
  word: StatusWord,
  needed: ReadonlySet<string>,
): QueryRow {
  const values: Record<string, string | null> = {
    completed_at: node.completed_at,
    created_at: node.created_at,
    description: node.description,
    external_ref: node.external_ref,
    hold: node.hold,
    hold_reason: node.hold_reason,
    lifecycle: node.lifecycle,
    priority: node.priority,
    size: node.size,
    status: word,
    target: node.target,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
  };
  if (needed.has('id')) {
    values.id = renderNodeIdWs(index, node);
  }
  if (needed.has('parent')) {
    const parent = node.parent_id === null ? undefined : index.nodeById.get(node.parent_id);
    values.parent = parent === undefined ? null : renderNodeIdWs(index, parent);
  }
  let tags: readonly string[] = [];
  if (needed.has('tag')) {
    tags = (index.ws.nodeTags.get(node.id) ?? []).map((t) => t.tag);
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
  const index = indexWorkingSet(await store.loadWorkingSet());
  const scopeId = opts.scope === undefined ? undefined : resolveScope(index, opts.scope);
  const candidates = index.ws.nodes
    .filter(
      (n) =>
        n.type === 'task' &&
        n.lifecycle === 'todo' &&
        n.hold === 'none' &&
        n.rank !== null &&
        !index.archived.has(n.project_id) &&
        (scopeId === undefined || n.project_id === scopeId) &&
        (opts.priority === undefined || n.priority === opts.priority) &&
        (opts.size === undefined || n.size === opts.size),
    )
    .toSorted(byProjectRank);

  const db = store.db;
  const verdicts = opts.verdicts ?? [];
  const ready: Node[] = [];
  for (const row of candidates) {
    if (!(await isReady(db, row))) {
      continue;
    }
    if (!(await passesVerdicts(db, row, verdicts))) {
      continue;
    }
    if (!compiled.test(toQueryRow(index, row, 'ready', compiled.needed))) {
      continue;
    }
    ready.push(row);
  }
  const limited = opts.limit !== undefined ? ready.slice(0, opts.limit) : ready;
  const facets = new Set(opts.facets);
  const items = await Promise.all(limited.map((node) => buildNodeView(db, node, facets)));
  return setResult(items, ready.length);
}

export type ListOptions = {
  scope?: string;
  /** The selection universe (MMR-33). Default `live`. */
  status?: StatusSelector;
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
  const universe = opts.status ?? 'live';
  const widened = (opts.filters ?? []).some((f) => f.field === 'type');
  const terminalOrder = universe === 'terminal' || universe === 'done' || universe === 'abandoned';

  const index = indexWorkingSet(await store.loadWorkingSet());
  const scopeId = opts.scope === undefined ? undefined : resolveScope(index, opts.scope);
  const matchesQ =
    opts.q === undefined || opts.q === '' ? undefined : likeMatcher(opts.q.toLowerCase());
  const rows = index.ws.nodes
    .filter((n) => {
      if (!widened) {
        if (n.type !== 'task') {
          return false;
        }
        // Task words map 1:1 onto lifecycle terminality — the coarse universe cut.
        if (terminalOrder) {
          if (n.lifecycle !== 'done' && n.lifecycle !== 'abandoned') {
            return false;
          }
        } else if (
          universe !== 'all' &&
          n.lifecycle !== 'todo' &&
          n.lifecycle !== 'in_progress' &&
          n.lifecycle !== 'under_review'
        ) {
          // Non-terminal lifecycle (incl. the under_review gate) — the live universe.
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
        !(index.ws.nodeTags.get(n.id) ?? []).some((t) => t.tag === opts.tag)
      ) {
        return false;
      }
      if (matchesQ !== undefined && !matchesQ(n.title)) {
        return false;
      }
      // Hide archived projects' subtrees (ADR 0015). The `archived` universe is a
      // project-level door handled by the transport, never reaching listNodes.
      return !index.archived.has(n.project_id);
    })
    .toSorted(terminalOrder ? byCompletedOrder : byRankOrder);

  const db = store.db;
  const verdicts = opts.verdicts ?? [];
  const matched: { node: Node; word: StatusWord }[] = [];
  for (const row of rows) {
    const word = await nodeStatusWord(db, row);
    if (!inUniverse(word, universe)) {
      continue;
    }
    if (!(await passesVerdicts(db, row, verdicts))) {
      continue;
    }
    if (!compiled.test(toQueryRow(index, row, word, compiled.needed))) {
      continue;
    }
    matched.push({ node: row, word });
  }
  const limited = opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
  const facets = new Set(opts.facets);
  const items = await Promise.all(limited.map(({ node }) => buildNodeView(db, node, facets)));
  return setResult(items, matched.length);
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
export async function getNode(db: Db, id: string, opts: GetOptions = {}): Promise<NodeView> {
  const facets = new Set<FacetName>(opts.facets ?? CHEAP_FACETS);
  const identity = parseIdentity(id);
  if (identity?.kind === 'project') {
    const project = await db
      .selectFrom('project')
      .selectAll()
      .where('key', '=', identity.key)
      .executeTakeFirst();
    if (project === undefined || project.archived_at !== null) {
      throw projectNotFound(identity.key);
    }
    return buildProjectView(db, project, facets);
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  const node = await findNodeByRef(db, id);
  if (node === undefined || (await isProjectArchived(db, node.project_id))) {
    throw notFound(`${id} doesn't exist`);
  }
  return buildNodeView(db, node, facets);
}

/**
 * `get KEY-aN` — identity selection of an artifact: metadata + links + tags
 * (MMR-32); the frozen body via the opt-in `content` column (MMR-34).
 */
export async function getArtifact(
  db: Db,
  id: string,
  opts: { content?: boolean } = {},
): Promise<ArtifactDetail> {
  const identity = parseIdentity(id);
  if (identity?.kind !== 'artifact') {
    throw notFound(`${id} is not an artifact id`, 'artifact ids look like KEY-aN');
  }
  const artifact = await findArtifactByRef(db, identity);
  if (artifact === undefined || (await isProjectArchived(db, artifact.project_id))) {
    throw notFound(`no artifact ${id}`);
  }
  return buildArtifactDetail(db, artifact, identity.key, opts);
}

/**
 * `status_of <id>` — a rollup distribution and its single `interpret` label,
 * for a node (`KEY-seq`) or a whole project (bare `KEY`, MMR-32).
 */
export async function statusOfNode(db: Db, id: string): Promise<StatusView> {
  const identity = parseIdentity(id);
  if (identity?.kind === 'project') {
    const project = await db
      .selectFrom('project')
      .select('id')
      .where('key', '=', identity.key)
      .executeTakeFirst();
    if (project === undefined || (await isProjectArchived(db, project.id))) {
      throw projectNotFound(identity.key);
    }
    const { status, distribution } = await statusOfProject(db, project.id);
    return { distribution, id: identity.key, status, type: 'project' };
  }
  if (identity?.kind === 'artifact') {
    throw validation(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  const node = await findNodeByRef(db, id);
  if (node === undefined || (await isProjectArchived(db, node.project_id))) {
    throw notFound(`${id} doesn't exist`);
  }
  const { status, distribution } = await statusOf(db, node);
  return { distribution, id: (await renderNodeId(db, node.id)) ?? id, status, type: node.type };
}
