import { sql } from "kysely";
import {
  type ArtifactDetail,
  CHEAP_FACETS,
  type FacetName,
  type NodeView,
  type SetResult,
  type StatusView,
} from "@mimir/contract";
import type { Priority, Size, StatusWord } from "@mimir/contract";
import type { FieldFilter, StatusSelector, ValueWarning, VerdictSelector } from "@mimir/contract";
import type { Node } from "../../db/schema";
import type { Db } from "../context";
import { isTerminalWord, nodeStatusWord, statusOf, statusOfProject } from "../derive";
import { notFound, projectNotFound, validation } from "../errors";
import { parseIdentity } from "../ids";
import { findArtifactByRef, findNodeByRef, renderNodeId } from "../lookup";
import { isBlocking, isOrphaned, isReady, isStale } from "../predicates";
import { type QueryRow, compileFilters } from "../query";
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
    throw projectNotFound(key);
  }
  return project.id;
}

function setResult(items: NodeView[], total: number, startsAt = 0): SetResult<NodeView> {
  return { total, returned: items.length, startsAt, items };
}

/** Does this Status word fall inside the selected universe? */
function inUniverse(word: StatusWord, selector: StatusSelector): boolean {
  if (selector === "all") return true;
  if (selector === "live") return !isTerminalWord(word);
  if (selector === "terminal") return isTerminalWord(word);
  return word === selector;
}

/** AND every `--is` / `--not-is` verdict against a node. */
async function passesVerdicts(
  db: Db,
  node: Node,
  verdicts: readonly VerdictSelector[],
): Promise<boolean> {
  for (const { verdict, negate } of verdicts) {
    const holds =
      verdict === "stale"
        ? await isStale(db, node)
        : verdict === "blocking"
          ? await isBlocking(db, node)
          : await isOrphaned(db, node);
    if (holds === negate) return false;
  }
  return true;
}

/**
 * Assemble a node's filter-evaluation row — the projection's bare values
 * under their external names. `needed` keeps the costly pieces (id/parent
 * rendering, the tag set) off rows no filter reads.
 */
async function toQueryRow(
  db: Db,
  node: Node,
  word: StatusWord,
  needed: ReadonlySet<string>,
): Promise<QueryRow> {
  const values: Record<string, string | null> = {
    type: node.type,
    title: node.title,
    status: word,
    description: node.description,
    priority: node.priority,
    size: node.size,
    lifecycle: node.lifecycle,
    hold: node.hold,
    hold_reason: node.hold_reason,
    target: node.target,
    external_ref: node.external_ref,
    created_at: node.created_at,
    updated_at: node.updated_at,
    completed_at: node.completed_at,
  };
  if (needed.has("id")) {
    values.id = await renderNodeId(db, node.id);
  }
  if (needed.has("parent")) {
    values.parent = node.parent_id === null ? null : await renderNodeId(db, node.parent_id);
  }
  let tags: string[] = [];
  if (needed.has("tag")) {
    const rows = await db
      .selectFrom("tag")
      .select("tag")
      .where("entity_type", "=", "node")
      .where("entity_id", "=", node.id)
      .execute();
    tags = rows.map((r) => r.tag);
  }
  return { values, tags };
}

const emptyResult = (warnings: ValueWarning[]): SetResult<NodeView> => ({
  total: 0,
  returned: 0,
  startsAt: 0,
  items: [],
  warnings,
});

export interface NextOptions {
  scope?: string;
  priority?: Priority;
  size?: Size;
  verdicts?: VerdictSelector[];
  filters?: FieldFilter[];
  limit?: number;
  facets?: readonly FacetName[];
}

/**
 * `next` — the headline "what's next": **ready** tasks (todo, un-held, every
 * dependency settled) in **rank** order. Scoped to a project if given; ordered
 * (project, rank) otherwise. `priority`/`size`/operators filter, never sort
 * (ADR 0007); the universe is fixed (ready *is* next's selection).
 */
export async function nextTasks(db: Db, opts: NextOptions = {}): Promise<SetResult<NodeView>> {
  const compiled = compileFilters(opts.filters ?? []);
  if (compiled.warnings.length > 0) {
    return emptyResult(compiled.warnings);
  }
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

  const verdicts = opts.verdicts ?? [];
  const ready: Node[] = [];
  for (const row of candidates) {
    if (!(await isReady(db, row))) continue;
    if (!(await passesVerdicts(db, row, verdicts))) continue;
    if (!compiled.test(await toQueryRow(db, row, "ready", compiled.needed))) continue;
    ready.push(row);
  }
  const limited = opts.limit !== undefined ? ready.slice(0, opts.limit) : ready;
  const facets = new Set(opts.facets ?? []);
  const items = await Promise.all(limited.map((node) => buildNodeView(db, node, facets)));
  return setResult(items, ready.length);
}

export interface ListOptions {
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
}

/**
 * `list` — broad selection (MMR-33): `--status` picks the universe (the
 * closed status words + `live`/`terminal`/`all` unions), `--is`/`--not-is`
 * verdicts and field operators filter within it, all AND-composed. Tasks
 * only, unless a `type` filter widens the selection to containers. Live
 * universes order by rank (nulls last); `terminal` orders by `completed_at`
 * descending (no rank outside the rankable set).
 */
export async function listNodes(db: Db, opts: ListOptions = {}): Promise<SetResult<NodeView>> {
  const compiled = compileFilters(opts.filters ?? []);
  if (compiled.warnings.length > 0) {
    return emptyResult(compiled.warnings);
  }
  const universe = opts.status ?? "live";
  const widened = (opts.filters ?? []).some((f) => f.field === "type");

  let query = db.selectFrom("node").selectAll();
  if (!widened) {
    query = query.where("type", "=", "task");
    // Task words map 1:1 onto lifecycle terminality — push the coarse cut to SQL.
    if (universe === "terminal" || universe === "done" || universe === "abandoned") {
      query = query.where("lifecycle", "in", ["done", "abandoned"]);
    } else if (universe !== "all") {
      query = query.where("lifecycle", "in", ["todo", "in_progress"]);
    }
  }
  if (opts.scope !== undefined) {
    query = query.where("project_id", "=", await resolveScope(db, opts.scope));
  }
  if (opts.priority !== undefined) {
    query = query.where("priority", "=", opts.priority);
  }
  if (opts.size !== undefined) {
    query = query.where("size", "=", opts.size);
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
  if (opts.q !== undefined && opts.q !== "") {
    const like = `%${opts.q.toLowerCase()}%`;
    query = query.where(sql<boolean>`lower(node.title) LIKE ${like}`);
  }
  const terminalOrder = universe === "terminal" || universe === "done" || universe === "abandoned";
  const rows = terminalOrder
    ? await query
        .orderBy(sql`completed_at is null`)
        .orderBy("completed_at", "desc")
        .orderBy("seq", "asc")
        .execute()
    : await query
        .orderBy(sql`rank is null`)
        .orderBy("rank", "asc")
        .orderBy("seq", "asc")
        .execute();

  const verdicts = opts.verdicts ?? [];
  const matched: { node: Node; word: StatusWord }[] = [];
  for (const row of rows) {
    const word = await nodeStatusWord(db, row);
    if (!inUniverse(word, universe)) continue;
    if (!(await passesVerdicts(db, row, verdicts))) continue;
    if (!compiled.test(await toQueryRow(db, row, word, compiled.needed))) continue;
    matched.push({ node: row, word });
  }
  const limited = opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
  const facets = new Set(opts.facets ?? []);
  const items = await Promise.all(limited.map(({ node }) => buildNodeView(db, node, facets)));
  return setResult(items, matched.length);
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
      throw projectNotFound(identity.key);
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
  if (identity?.kind !== "artifact") {
    throw notFound(`no artifact with id ${id}`);
  }
  const artifact = await findArtifactByRef(db, identity);
  if (artifact === undefined) {
    throw notFound(`no artifact with id ${id}`);
  }
  return buildArtifactDetail(db, artifact, identity.key, opts);
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
      throw projectNotFound(identity.key);
    }
    const { status, distribution } = await statusOfProject(db, project.id);
    return { id: identity.key, type: "project", status, distribution };
  }
  if (identity?.kind === "artifact") {
    throw validation(`${id} is an artifact, not a project or node`);
  }
  const node = await findNodeByRef(db, id);
  if (node === undefined) {
    throw notFound(`no node with id ${id}`);
  }
  const { status, distribution } = await statusOf(db, node);
  return { id: (await renderNodeId(db, node.id)) ?? id, type: node.type, status, distribution };
}
