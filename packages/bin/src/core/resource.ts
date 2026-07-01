import type { FacetName, NodeView, TransitionsResult, TreeView } from '@mimir/contract';
import { sql } from 'kysely';

import type { Node } from '../db/schema';
import type { Db } from './context';
import { notFound, projectNotFound, validation } from './errors';
import { parseIdentity } from './ids';
import { buildNodeView, buildProjectView } from './intent/view';
import { findNodeByRef, isProjectArchived, renderNodeId, renderProjectKey } from './lookup';

/**
 * The resource-envelope reads (ADR 0012) — whole-portfolio and whole-project
 * selections the intent layer deliberately doesn't offer: every project at
 * once, a project's full nested tree, and the cross-cutting transition feed.
 * Core capabilities like any other; the HTTP API is just their first renderer.
 */

/** Every project, key-ordered, through the shared projection (rollup riding as `distribution`). */
/**
 * List projects. Archived projects are hidden by default (ADR 0015); `filter`
 * opts into the shelf — `'archived'` returns only archived projects (the
 * `list --status archived` door), `'all'` returns everything.
 */
export async function listProjects(
  db: Db,
  facets: readonly FacetName[] = ['distribution', 'tags'],
  filter: 'active' | 'archived' | 'all' = 'active',
): Promise<NodeView[]> {
  let query = db.selectFrom('project').selectAll().orderBy('key', 'asc');
  if (filter === 'active') {
    query = query.where('archived_at', 'is', null);
  } else if (filter === 'archived') {
    query = query.where('archived_at', 'is not', null);
  }
  const projects = await query.execute();
  return Promise.all(projects.map((p) => buildProjectView(db, p, new Set(facets))));
}

/**
 * Children of one parent in board order: the rankable set by rank, everything
 * else (containers, terminal tasks) by seq after it. Rank crosses the surface
 * as array order, never a field (ADR 0007).
 */
async function childRows(db: Db, projectId: number, parentId: number | null): Promise<Node[]> {
  let query = db.selectFrom('node').selectAll().where('project_id', '=', projectId);
  query =
    parentId === null
      ? query.where('parent_id', 'is', null)
      : query.where('parent_id', '=', parentId);
  return query
    .orderBy(sql`rank is null`)
    .orderBy('rank', 'asc')
    .orderBy('seq', 'asc')
    .execute();
}

/**
 * `projectTree` — the whole hierarchy in one read (the board view): the
 * project record at the root, every node nested under its parent, each level
 * in rank-then-seq order. One record shape throughout (`TreeView`).
 */
export async function projectTree(
  db: Db,
  key: string,
  facets: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts'],
): Promise<TreeView> {
  const project = await db
    .selectFrom('project')
    .selectAll()
    .where('key', '=', key)
    .executeTakeFirst();
  // An archived project reads as absent (ADR 0015).
  if (project === undefined || project.archived_at !== null) {
    throw projectNotFound(key);
  }
  const facetSet = new Set(facets);

  const subtree = async (node: Node): Promise<TreeView> => {
    const view = await buildNodeView(db, node, facetSet);
    const children = await childRows(db, project.id, node.id);
    const { children: _refs, ...record } = view;
    return { ...record, children: await Promise.all(children.map(subtree)) };
  };

  const rootView = await buildProjectView(db, project, facetSet);
  const roots = await childRows(db, project.id, null);
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
  db: Db,
  id: string,
  facets: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts'],
): Promise<TreeView> {
  const identity = parseIdentity(id);
  if (identity === null) {
    throw notFound(`${id} is not a valid id`);
  }
  // Project root — delegate to the existing builder.
  if (identity.kind === 'project') {
    return projectTree(db, identity.key, facets);
  }
  if (identity.kind === 'artifact') {
    throw notFound(`${id} is an artifact, not a project or a task/phase/initiative`);
  }
  // Node id — resolve it and recurse down. An archived project's subtree reads as absent (ADR 0015).
  const rootNode = await findNodeByRef(db, id);
  if (rootNode === undefined || (await isProjectArchived(db, rootNode.project_id))) {
    throw notFound(`${id} doesn't exist`);
  }
  const facetSet = new Set(facets);

  const subtree = async (node: Node): Promise<TreeView> => {
    const view = await buildNodeView(db, node, facetSet);
    const children = await childRows(db, node.project_id, node.id);
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
