import { sql } from "kysely";
import type { NodeView, TransitionsResult, TreeView } from "@mimir/contract";
import type { FacetName } from "@mimir/contract";
import type { Node } from "../db/schema";
import type { Db } from "./context";
import { notFound, validation } from "./errors";
import { renderNodeId } from "./lookup";
import { buildNodeView, buildProjectView } from "./intent/view";

/**
 * The resource-envelope reads (ADR 0012) — whole-portfolio and whole-project
 * selections the intent layer deliberately doesn't offer: every project at
 * once, a project's full nested tree, and the cross-cutting transition feed.
 * Core capabilities like any other; the HTTP API is just their first renderer.
 */

/** Every project, key-ordered, through the shared projection (rollup riding as `distribution`). */
export async function listProjects(
  db: Db,
  facets: readonly FacetName[] = ["distribution", "tags"],
): Promise<NodeView[]> {
  const projects = await db.selectFrom("project").selectAll().orderBy("key", "asc").execute();
  return Promise.all(projects.map((p) => buildProjectView(db, p, new Set(facets))));
}

/**
 * Children of one parent in board order: the rankable set by rank, everything
 * else (containers, terminal tasks) by seq after it. Rank crosses the surface
 * as array order, never a field (ADR 0007).
 */
async function childRows(db: Db, projectId: number, parentId: number | null): Promise<Node[]> {
  let query = db.selectFrom("node").selectAll().where("project_id", "=", projectId);
  query =
    parentId === null
      ? query.where("parent_id", "is", null)
      : query.where("parent_id", "=", parentId);
  return query
    .orderBy(sql`rank is null`)
    .orderBy("rank", "asc")
    .orderBy("seq", "asc")
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
  facets: readonly FacetName[] = ["deps", "tags", "distribution", "verdicts"],
): Promise<TreeView> {
  const project = await db
    .selectFrom("project")
    .selectAll()
    .where("key", "=", key)
    .executeTakeFirst();
  if (project === undefined) {
    throw notFound(`no project ${key}`);
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

export interface TransitionsOptions {
  /** Opaque resume cursor from a prior read — only strictly-newer entries return. */
  since?: string;
  limit?: number;
}

/**
 * The cross-cutting transition feed — the caller-supplied-cursor read over the
 * append-only log (ADR 0002/0003): entries after `since` in log order, node
 * ids rendered. The cursor is opaque to callers; `nextCursor` resumes exactly.
 */
export async function listTransitions(
  db: Db,
  opts: TransitionsOptions = {},
): Promise<TransitionsResult> {
  let after = 0;
  if (opts.since !== undefined) {
    after = Number(opts.since);
    if (!Number.isInteger(after) || after < 0) {
      throw validation(`invalid cursor ${opts.since}`, "pass back a next_cursor you were given");
    }
  }
  let query = db
    .selectFrom("transition_log")
    .selectAll()
    .where("id", ">", after)
    .orderBy("id", "asc");
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw validation(`invalid limit ${String(opts.limit)}`);
    }
    query = query.limit(opts.limit);
  }
  const rows = await query.execute();
  const items = await Promise.all(
    rows.map(async (row) => ({
      node: (await renderNodeId(db, row.node_id)) ?? "unknown",
      kind: row.kind,
      from: row.from_value,
      to: row.to_value,
      at: row.at,
      reason: row.reason,
    })),
  );
  const last = rows.at(-1);
  return last === undefined ? { items } : { items, nextCursor: String(last.id) };
}
