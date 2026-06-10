import { sql } from "kysely";
import {
  CHEAP_FACETS,
  type FacetName,
  type NodeView,
  type SetResult,
  type StatusView,
} from "../../contract/dto";
import type { NodeType, Priority, Size } from "../../contract/enums";
import type { Node } from "../../db/schema";
import type { Db } from "../context";
import { statusOf } from "../derive";
import { notFound } from "../errors";
import { findNodeByRef, renderNodeId } from "../lookup";
import { isAwaiting, isBlocking, isOrphaned, isReady, isStale } from "../predicates";
import { buildNodeView } from "./view";

/**
 * The intent layer — the read surface both the CLI and MCP render. Commands
 * differ only in *how they identify rows* (predicate vs. identity); everything
 * downstream is one projection contract (output-contract reference).
 */

async function resolveScope(db: Db, key: string): Promise<number> {
  const project = await db
    .selectFrom("project")
    .select("id")
    .where("key", "=", key)
    .executeTakeFirst();
  if (project === undefined) {
    throw notFound(`no project with key ${key}`);
  }
  return project.id;
}

function setResult(items: NodeView[], total: number, startsAt = 0): SetResult<NodeView> {
  return { total, returned: items.length, startsAt, items };
}

export interface NextOptions {
  scope?: string;
  priority?: Priority;
  size?: Size;
  limit?: number;
  facets?: readonly FacetName[];
}

/**
 * `next` — the headline "what's next": **ready** tasks (todo, un-held, every
 * dependency settled) in **rank** order. Scoped to a project if given; ordered
 * (project, rank) otherwise. `priority`/`size` filter, never sort (ADR 0007).
 */
export async function nextTasks(db: Db, opts: NextOptions = {}): Promise<SetResult<NodeView>> {
  let query = db
    .selectFrom("node")
    .selectAll()
    .where("type", "=", "task")
    .where("lifecycle", "=", "todo")
    .where("hold", "=", "none")
    .where("rank", "is not", null);
  if (opts.scope !== undefined) {
    query = query.where("project_id", "=", await resolveScope(db, opts.scope));
  }
  if (opts.priority !== undefined) {
    query = query.where("priority", "=", opts.priority);
  }
  if (opts.size !== undefined) {
    query = query.where("size", "=", opts.size);
  }
  const candidates = await query.orderBy("project_id", "asc").orderBy("rank", "asc").execute();

  const ready: Node[] = [];
  for (const row of candidates) {
    if (await isReady(db, row)) {
      ready.push(row);
    }
  }
  const limited = opts.limit !== undefined ? ready.slice(0, opts.limit) : ready;
  const facets = new Set(opts.facets ?? []);
  const items = await Promise.all(limited.map((node) => buildNodeView(db, node, facets)));
  return setResult(items, ready.length);
}

export type ListPredicate =
  | "all"
  | "ready"
  | "awaiting"
  | "blocked"
  | "stale"
  | "blocking"
  | "orphaned";

export interface ListOptions {
  scope?: string;
  predicate?: ListPredicate;
  priority?: Priority;
  size?: Size;
  type?: NodeType;
  tag?: string;
  limit?: number;
  facets?: readonly FacetName[];
}

/**
 * `list` — broad predicate selection over non-terminal tasks in rank order
 * (nulls last). The derived predicates (`ready`/`awaiting`/`stale`/`blocking`/
 * `orphaned`) are applied live after loading; `blocked` and the scalar filters
 * are pushed to SQL.
 */
export async function listNodes(db: Db, opts: ListOptions = {}): Promise<SetResult<NodeView>> {
  const predicate = opts.predicate ?? "all";
  let query = db
    .selectFrom("node")
    .selectAll()
    .where("type", "=", opts.type ?? "task")
    .where("lifecycle", "in", ["todo", "in_progress"]);
  if (opts.scope !== undefined) {
    query = query.where("project_id", "=", await resolveScope(db, opts.scope));
  }
  if (opts.priority !== undefined) {
    query = query.where("priority", "=", opts.priority);
  }
  if (opts.size !== undefined) {
    query = query.where("size", "=", opts.size);
  }
  if (predicate === "blocked") {
    query = query.where("hold", "=", "blocked");
  }
  if (opts.tag !== undefined) {
    const tag = opts.tag;
    query = query.where("id", "in", (eb) =>
      eb
        .selectFrom("tag")
        .select("entity_id")
        .where("entity_type", "=", "node")
        .where("tag", "=", tag),
    );
  }
  const rows = await query
    .orderBy(sql`rank is null`)
    .orderBy("rank", "asc")
    .orderBy("seq", "asc")
    .execute();

  const matched: Node[] = [];
  for (const row of rows) {
    if (await matchesPredicate(db, row, predicate)) {
      matched.push(row);
    }
  }
  const limited = opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
  const facets = new Set(opts.facets ?? []);
  const items = await Promise.all(limited.map((node) => buildNodeView(db, node, facets)));
  return setResult(items, matched.length);
}

async function matchesPredicate(db: Db, node: Node, predicate: ListPredicate): Promise<boolean> {
  switch (predicate) {
    case "all":
    case "blocked": // already filtered in SQL
      return true;
    case "ready":
      return isReady(db, node);
    case "awaiting":
      return isAwaiting(db, node);
    case "stale":
      return isStale(db, node);
    case "blocking":
      return isBlocking(db, node);
    case "orphaned":
      return isOrphaned(db, node);
  }
}

export interface GetOptions {
  facets?: readonly FacetName[];
}

/**
 * `get <id>` — identity selection by `KEY-seq`. Full record: all bare fields +
 * cheap facets by default (`history` stays opt-in). A missing target throws
 * (non-zero exit — identity selection).
 */
export async function getNode(db: Db, id: string, opts: GetOptions = {}): Promise<NodeView> {
  const node = await findNodeByRef(db, id);
  if (node === undefined) {
    throw notFound(`no node with id ${id}`);
  }
  const facets = new Set<FacetName>(opts.facets ?? CHEAP_FACETS);
  return buildNodeView(db, node, facets);
}

/** `status_of <id>` — a node's rollup distribution and its single `interpret` label. */
export async function statusOfNode(db: Db, id: string): Promise<StatusView> {
  const node = await findNodeByRef(db, id);
  if (node === undefined) {
    throw notFound(`no node with id ${id}`);
  }
  const { status, distribution } = await statusOf(db, node);
  return { id: (await renderNodeId(db, node.id)) ?? id, status, distribution };
}
