import { sql } from "kysely";
import {
  type ArtifactDetail,
  CHEAP_FACETS,
  type FacetName,
  type NodeView,
  type SetResult,
  type StatusView,
} from "../../contract/dto";
import type { NodeType, Priority, Size } from "../../contract/enums";
import type { Node } from "../../db/schema";
import type { Db } from "../context";
import { statusOf, statusOfProject } from "../derive";
import { notFound, validation } from "../errors";
import { parseIdentity } from "../ids";
import { findArtifactByRef, findNodeByRef, renderNodeId } from "../lookup";
import { isAwaiting, isBlocking, isOrphaned, isReady, isStale } from "../predicates";
import { buildArtifactDetail, buildNodeView, buildProjectView } from "./view";

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
 * `get <id>` — identity selection by the full grammar (MMR-32): a node
 * (`KEY-seq`) or a whole project (bare `KEY`), as one shared projection. Full
 * record: all bare fields + cheap facets by default (`history` stays opt-in).
 * A missing target throws (non-zero exit — identity selection). Artifacts
 * (`KEY-aN`) have their own shape — see {@link getArtifact}.
 */
export async function getNode(db: Db, id: string, opts: GetOptions = {}): Promise<NodeView> {
  const facets = new Set<FacetName>(opts.facets ?? CHEAP_FACETS);
  const identity = parseIdentity(id);
  if (identity?.kind === "project") {
    const project = await db
      .selectFrom("project")
      .selectAll()
      .where("key", "=", identity.key)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound(`no project ${id}`);
    }
    return buildProjectView(db, project, facets);
  }
  if (identity?.kind === "artifact") {
    throw validation(`${id} is an artifact — use getArtifact`, "transports dispatch on the id");
  }
  const node = await findNodeByRef(db, id);
  if (node === undefined) {
    throw notFound(`no node with id ${id}`);
  }
  return buildNodeView(db, node, facets);
}

/** `get KEY-aN` — identity selection of an artifact: metadata + links + tags (MMR-32). */
export async function getArtifact(db: Db, id: string): Promise<ArtifactDetail> {
  const identity = parseIdentity(id);
  if (identity?.kind !== "artifact") {
    throw notFound(`no artifact with id ${id}`);
  }
  const artifact = await findArtifactByRef(db, identity);
  if (artifact === undefined) {
    throw notFound(`no artifact with id ${id}`);
  }
  return buildArtifactDetail(db, artifact, identity.key);
}

/**
 * `status_of <id>` — a rollup distribution and its single `interpret` label,
 * for a node (`KEY-seq`) or a whole project (bare `KEY`, MMR-32).
 */
export async function statusOfNode(db: Db, id: string): Promise<StatusView> {
  const identity = parseIdentity(id);
  if (identity?.kind === "project") {
    const project = await db
      .selectFrom("project")
      .select("id")
      .where("key", "=", identity.key)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound(`no project ${id}`);
    }
    const { status, distribution } = await statusOfProject(db, project.id);
    return { id: identity.key, status, distribution };
  }
  if (identity?.kind === "artifact") {
    throw validation(`${id} is an artifact, not a project or node`);
  }
  const node = await findNodeByRef(db, id);
  if (node === undefined) {
    throw notFound(`no node with id ${id}`);
  }
  const { status, distribution } = await statusOf(db, node);
  return { id: (await renderNodeId(db, node.id)) ?? id, status, distribution };
}
