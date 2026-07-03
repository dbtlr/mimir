import type { FacetName, NodeView, TransitionsResult, TreeView } from '@mimir/contract';

import type { Db } from './context';
import type { DerivationSet } from './derive';
import { deriveSet, findNodeInSet } from './derive';
import { notFound, projectNotFound, validation } from './errors';
import { parseIdentity } from './ids';
import { buildNodeView, buildProjectView } from './intent/view';
import { renderNodeId, renderProjectKey } from './lookup';
import type { Node } from './model';
import type { Store } from './store';

/**
 * The resource-envelope reads (ADR 0012) — whole-portfolio and whole-project
 * selections the intent layer deliberately doesn't offer: every project at
 * once, a project's full nested tree, and the cross-cutting transition feed.
 * Core capabilities like any other; the HTTP API is just their first renderer.
 * Each read derives over one working-set snapshot (ADR 0016 Phase 0) — the
 * portfolio list shares a single memoized set across every project's rollup,
 * leaf counts, and attention state.
 */

/**
 * List projects. Archived projects are hidden by default (ADR 0015); `filter`
 * opts into the shelf — `'archived'` returns only archived projects (the
 * `list --status archived` door), `'all'` returns everything.
 */
export async function listProjects(
  store: Store,
  facets: readonly FacetName[] = ['distribution', 'tags'],
  filter: 'active' | 'archived' | 'all' = 'active',
): Promise<NodeView[]> {
  const set = deriveSet(await store.loadWorkingSet());
  // ws.projects is key-ordered; the filter picks the shelf.
  const projects = set.ws.projects.filter((p) => {
    if (filter === 'active') {
      return p.archived_at === null;
    }
    if (filter === 'archived') {
      return p.archived_at !== null;
    }
    return true;
  });
  return Promise.all(
    projects.map((p) => buildProjectView(store.artifacts, set, p, new Set(facets))),
  );
}

/**
 * Children of one parent in board order: the rankable set by rank, everything
 * else (containers, terminal tasks) by seq after it. Rank crosses the surface
 * as array order, never a field (ADR 0007).
 */
function boardOrder(a: Node, b: Node): number {
  const aNull = a.rank === null ? 1 : 0;
  const bNull = b.rank === null ? 1 : 0;
  return aNull - bNull || (a.rank ?? 0) - (b.rank ?? 0) || a.seq - b.seq;
}

function childRows(set: DerivationSet, projectId: number, parentId: number | null): Node[] {
  const children =
    parentId === null
      ? (set.nodesByProject.get(projectId) ?? []).filter((n) => n.parent_id === null)
      : (set.childrenByParent.get(parentId) ?? []);
  return children.toSorted(boardOrder);
}

/**
 * `projectTree` — the whole hierarchy in one read (the board view): the
 * project record at the root, every node nested under its parent, each level
 * in rank-then-seq order. One record shape throughout (`TreeView`).
 */
export async function projectTree(
  store: Store,
  key: string,
  facets: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts'],
): Promise<TreeView> {
  const set = deriveSet(await store.loadWorkingSet());
  const project = set.ws.projects.find((p) => p.key === key);
  // An archived project reads as absent (ADR 0015).
  if (project === undefined || project.archived_at !== null) {
    throw projectNotFound(key);
  }
  const facetSet = new Set(facets);

  const subtree = async (node: Node): Promise<TreeView> => {
    const view = await buildNodeView(store.db, store.artifacts, set, node, facetSet);
    const children = childRows(set, project.id, node.id);
    const { children: _refs, ...record } = view;
    return { ...record, children: await Promise.all(children.map(subtree)) };
  };

  const rootView = await buildProjectView(store.artifacts, set, project, facetSet);
  const roots = childRows(set, project.id, null);
  const { children: _refs, ...record } = rootView;
  return { ...record, children: await Promise.all(roots.map(subtree)) };
}

/**
 * `nodeTree` — the hierarchy rooted at any node id (`KEY-seq`) or a whole
 * project (`KEY`). Delegates the project-root case to `projectTree`; for a
 * mid-tree node it builds the subtree using the same `childRows` + `buildNodeView`
 * pipeline — one tree builder, not two (MMR-90).
 */
export async function nodeTree(
  store: Store,
  id: string,
  facets: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts'],
): Promise<TreeView> {
  const identity = parseIdentity(id);
  if (identity === null) {
    throw notFound(`${id} is not a valid id`);
  }
  // Project root — delegate to the existing builder.
  if (identity.kind === 'project') {
    return projectTree(store, identity.key, facets);
  }
  if (identity.kind === 'artifact') {
    throw notFound(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  // Node id — resolve it against the snapshot and recurse down. An archived
  // project's subtree reads as absent (ADR 0015).
  const set = deriveSet(await store.loadWorkingSet());
  const rootNode = findNodeInSet(set, id);
  if (rootNode === undefined || set.archivedProjects.has(rootNode.project_id)) {
    throw notFound(`${id} doesn't exist`);
  }
  const facetSet = new Set(facets);

  const subtree = async (node: Node): Promise<TreeView> => {
    const view = await buildNodeView(store.db, store.artifacts, set, node, facetSet);
    const children = childRows(set, node.project_id, node.id);
    const { children: _refs, ...record } = view;
    return { ...record, children: await Promise.all(children.map(subtree)) };
  };

  return subtree(rootNode);
}

export type TransitionsOptions = {
  /** Opaque resume cursor from a prior read — only strictly-newer entries return. */
  since?: string;
  limit?: number;
};

/**
 * The cross-cutting transition feed — the caller-supplied-cursor read over the
 * append-only log (ADR 0002/0003): entries after `since` in log order, node
 * ids rendered. The cursor is opaque to callers; `nextCursor` resumes exactly.
 */
/**
 * Render the entity a transition row belongs to (ADR 0015): a node-keyed row
 * yields its `KEY-seq`, an archive row its project `KEY` — both valid identity
 * tokens for the `node` field of the cross-cutting transitions read.
 */
async function renderTransitionEntity(
  db: Db,
  row: { node_id: number | null; project_id: number | null },
): Promise<string> {
  if (row.node_id !== null) {
    return (await renderNodeId(db, row.node_id)) ?? 'unknown';
  }
  if (row.project_id !== null) {
    return (await renderProjectKey(db, row.project_id)) ?? 'unknown';
  }
  return 'unknown';
}

export async function listTransitions(
  db: Db,
  opts: TransitionsOptions = {},
): Promise<TransitionsResult> {
  let after = 0;
  if (opts.since !== undefined) {
    after = Number(opts.since);
    if (!Number.isInteger(after) || after < 0) {
      throw validation(`invalid cursor ${opts.since}`, 'pass back a next_cursor you were given');
    }
  }
  let query = db
    .selectFrom('transition_log')
    .selectAll()
    .where('id', '>', after)
    .orderBy('id', 'asc');
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw validation(`invalid limit ${String(opts.limit)}`);
    }
    query = query.limit(opts.limit);
  }
  const rows = await query.execute();
  const items = await Promise.all(
    rows.map(async (row) => ({
      at: row.at,
      from: row.from_value,
      kind: row.kind,
      node: await renderTransitionEntity(db, row),
      reason: row.reason,
      to: row.to_value,
    })),
  );
  const last = rows.at(-1);
  return last === undefined ? { items } : { items, nextCursor: String(last.id) };
}
