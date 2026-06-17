import type { Server } from "bun";
import type { FacetName, FieldFilter, NodeView, Priority, Size } from "@mimir/contract";
import {
  NODE_TYPE_VALUES,
  QUERY_OP_VALUES,
  STATUS_SELECTOR_VALUES,
  type StatusSelector,
  VERDICT_VALUES,
  type Verdict,
  type VerdictSelector,
} from "@mimir/contract";
import type { Db, ListOptions, RankPosition, UpdateFields } from "../core";
import {
  abandonTask,
  annotate,
  artifactSummaryToWire,
  artifactToWire,
  attachArtifact,
  blockTask,
  buildNodeView,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  findArtifactByRef,
  findNodeByRef,
  resolveNodeToken,
  getArtifact,
  getNode,
  listArtifacts,
  listNodes,
  listProjects,
  listTransitions,
  moveNode,
  nodeToWire,
  notFound,
  parkTask,
  parseFilterToken,
  parseId,
  parseIdentity,
  projectTree,
  reorder,
  startTask,
  tagEntities,
  treeToWire,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  validation,
} from "../core";
import { guarded, json, preflight, readBody, requiredStr, strField, strList } from "./respond";
import { uiResponse, type UiAssetMap } from "./static";
import { UI_ASSETS } from "./ui-assets.generated";

/** A bare `YYYY-MM-DD` filter date → an ISO-ms bound; full timestamps pass through. */
function normalizeDate(value: string, edge: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }
  return value;
}

/**
 * The HTTP transport — the resource envelope (ADR 0012): conventional,
 * extensible REST over the core for the operator-console UI. Reads are
 * resource-shaped; writes are the core verbs as action sub-routes (`PATCH` is
 * exactly the dumb `update`). Loopback-only, plain HTTP — TLS, exposure, and
 * auth (open question) belong to the proxy in front.
 *
 * Route-level contract: `MMR-14`'s annotations. Collections return envelope
 * objects (`{items: […]}`) so cursor metadata can arrive later non-breaking.
 */

/** The set-read projection — one record shape on every collection (boundary at selection). */
const SET_FACETS: readonly FacetName[] = ["deps", "tags", "distribution", "verdicts"];
/** Detail/echo add the artifact inventory (id + title — content stays a sub-resource) and the per-node transition history. */
const DETAIL_FACETS: readonly FacetName[] = [...SET_FACETS, "artifacts", "history"];
/** The project-record projection (verdicts/deps don't apply to a project). */
const PROJECT_FACETS: readonly FacetName[] = ["children", "distribution", "tags", "artifacts"];

/** Resolve a node token for a verb — the HTTP binding of the core guard, with route pointers. */
async function nodeRef(db: Db, token: string, expected = "node"): Promise<number> {
  return resolveNodeToken(db, token, expected, {
    project: "projects live at /api/projects",
    artifact: "artifacts live at /api/artifacts",
  });
}

/** The write echo — the full updated record, same shape as `GET /api/nodes/:id`. */
async function echoNode(
  db: Db,
  req: Request,
  node: Parameters<typeof buildNodeView>[1],
  status = 200,
): Promise<Response> {
  const view = await buildNodeView(db, node, new Set(DETAIL_FACETS));
  return json(req, nodeToWire(view), status);
}

/** A collection body: the envelope object, warnings folded in when present. */
function setBody(total: number, items: NodeView[], warnings?: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = { total, items: items.map(nodeToWire) };
  if (warnings !== undefined && warnings.length > 0) {
    body.warnings = warnings;
  }
  return body;
}

/** Parse `/api/nodes` query params into a `listNodes` selection. */
function parseNodesQuery(url: URL): { opts: ListOptions; badStatus?: string } {
  const q = url.searchParams;
  const filters: FieldFilter[] = [];
  for (const op of QUERY_OP_VALUES) {
    for (const token of q.getAll(op)) {
      filters.push(parseFilterToken(op, token));
    }
  }
  const type = q.get("type");
  if (type !== null) {
    filters.push(parseFilterToken("in", `type:${type}`));
  } else if (!filters.some((f) => f.field === "type")) {
    // No type selection → the whole tree, not the intent layer's tasks-only default.
    filters.push({ op: "in", field: "type", value: NODE_TYPE_VALUES.join(",") });
  }
  const priority = q.get("priority");
  if (priority !== null) {
    filters.push(parseFilterToken("eq", `priority:${priority}`));
  }
  const size = q.get("size");
  if (size !== null) {
    filters.push(parseFilterToken("eq", `size:${size}`));
  }

  const verdicts: VerdictSelector[] = [];
  for (const [param, negate] of [
    ["is", false],
    ["not-is", true],
  ] as const) {
    for (const raw of q.getAll(param)) {
      for (const token of raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)) {
        if (!(VERDICT_VALUES as readonly string[]).includes(token)) {
          throw validation(`unknown verdict ${token}`, `verdicts: ${VERDICT_VALUES.join(", ")}`);
        }
        verdicts.push({ verdict: token as Verdict, negate });
      }
    }
  }

  const opts: ListOptions = { filters, verdicts, facets: SET_FACETS };
  const scope = q.get("project");
  if (scope !== null) {
    opts.scope = scope;
  }
  const tag = q.get("tag");
  if (tag !== null) {
    opts.tag = tag;
  }
  const qText = q.get("q");
  if (qText !== null && qText !== "") {
    opts.q = qText;
  }
  const limit = q.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) {
      throw validation(`invalid limit ${limit}`);
    }
    opts.limit = n;
  }
  const status = q.get("status");
  if (status !== null) {
    if (!(STATUS_SELECTOR_VALUES as readonly string[]).includes(status)) {
      return { opts, badStatus: status };
    }
    opts.status = status as StatusSelector;
  }
  return { opts };
}

export interface ServeOptions {
  port: number;
  /** Reported by /api/health — how `service status` asks a live process what it is. */
  version: string;
  /** The embedded-UI manifest; tests inject fixtures, prod uses the generated map. */
  assets?: UiAssetMap;
  /** The MMR-53 walk-upward convenience; the daemon posture passes false (declared port, loud failure). */
  hunt?: boolean;
}

/** How far past a taken port the hunt walks before giving up (MMR-53). */
export const PORT_HUNT_SPAN = 20;

/** Bun's bind-collision error — the only one the hunt may swallow. */
function isPortTaken(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

/**
 * Build and start the server. Binds `127.0.0.1` unconditionally — the
 * loopback-only posture is the architecture, not a default (ADR 0012). A taken
 * port hunts upward (+1 … +`PORT_HUNT_SPAN`) to the next free one — a dev
 * convenience; a supervised deployment pins the port and the proxy points at
 * it. Callers must surface the bound port: it may differ from the request.
 */
export function createServer(db: Db, opts: ServeOptions): Server<undefined> {
  const last = Math.min(opts.port + PORT_HUNT_SPAN, 65535);
  for (let port = opts.port; ; port++) {
    try {
      return bindServer(db, opts, port);
    } catch (err) {
      if (!isPortTaken(err) || opts.port === 0 || opts.hunt === false) {
        throw err;
      }
      if (port >= last) {
        throw Object.assign(
          new Error(`ports ${String(opts.port)}–${String(last)} are all in use`),
          {
            code: "EADDRINUSE",
          },
        );
      }
    }
  }
}

function bindServer(db: Db, opts: ServeOptions, port: number): Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/api/health": {
        GET: (req) => json(req, { status: "ok", version: opts.version }),
      },

      "/api/projects": {
        GET: (req) =>
          guarded(req, async () => {
            const items = await listProjects(db);
            return json(req, setBody(items.length, items));
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["key", "name", "tags"]);
            const project = await createProject(db, {
              key: requiredStr(body, "key", "create project"),
              name: requiredStr(body, "name", "create project"),
              tags: strList(body, "tags"),
            });
            const view = await getNode(db, project.key, { facets: PROJECT_FACETS });
            return json(req, nodeToWire(view), 201);
          }),
      },

      "/api/projects/:key": {
        GET: (req) =>
          guarded(req, async () => {
            const key = req.params.key;
            if (parseIdentity(key)?.kind !== "project") {
              throw validation(`${key} is not a project key`, "nodes live at /api/nodes/:id");
            }
            const view = await getNode(db, key, { facets: PROJECT_FACETS });
            return json(req, nodeToWire(view));
          }),
      },

      "/api/projects/:key/tree": {
        GET: (req) =>
          guarded(req, async () => {
            const key = req.params.key;
            if (parseIdentity(key)?.kind !== "project") {
              throw validation(`${key} is not a project key`);
            }
            return json(req, treeToWire(await projectTree(db, key)));
          }),
      },

      "/api/nodes": {
        GET: (req) =>
          guarded(req, async () => {
            const { opts, badStatus } = parseNodesQuery(new URL(req.url));
            if (badStatus !== undefined) {
              return json(req, {
                total: 0,
                items: [],
                warnings: [
                  {
                    code: "no_match_value",
                    field: "status",
                    value: badStatus,
                    message: `${badStatus} is not a status`,
                    expected: [...STATUS_SELECTOR_VALUES],
                  },
                ],
              });
            }
            const result = await listNodes(db, opts);
            return json(req, setBody(result.total, result.items, result.warnings));
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              "type",
              "parent",
              "title",
              "description",
              "target",
              "priority",
              "size",
              "external_ref",
              "tags",
            ]);
            const type = requiredStr(body, "type", "create");
            const parent = requiredStr(body, "parent", "create");
            const title = requiredStr(body, "title", "create");
            const description = strField(body, "description");
            const tags = strList(body, "tags");
            if (type === "initiative") {
              if (parseId(parent) !== null) {
                throw validation("an initiative's parent must be a project KEY, not a node ref");
              }
              const project = await db
                .selectFrom("project")
                .select("id")
                .where("key", "=", parent)
                .executeTakeFirst();
              if (project === undefined) {
                throw notFound(`no project ${parent}`);
              }
              const node = await createInitiative(db, {
                projectId: project.id,
                title,
                description,
                tags,
              });
              return echoNode(db, req, node, 201);
            }
            if (type === "phase") {
              const node = await createPhase(db, {
                parentId: await nodeRef(db, parent, "initiative"),
                title,
                description,
                target: strField(body, "target"),
                tags,
              });
              return echoNode(db, req, node, 201);
            }
            if (type === "task") {
              const priority = strField(body, "priority");
              const size = strField(body, "size");
              const node = await createTask(db, {
                parentId: await nodeRef(db, parent, "phase or initiative"),
                title,
                description,
                priority: priority !== undefined ? (priority as Priority) : undefined,
                size: size !== undefined ? (size as Size) : undefined,
                externalRef: strField(body, "external_ref"),
                tags,
              });
              return echoNode(db, req, node, 201);
            }
            throw validation(
              `create: unknown type ${type}`,
              "types: initiative, phase, task — projects via POST /api/projects",
            );
          }),
      },

      "/api/nodes/:id": {
        GET: (req) =>
          guarded(req, async () => {
            const id = req.params.id;
            const identity = parseIdentity(id);
            if (identity?.kind === "project") {
              throw validation(`${id} is a project`, `use /api/projects/${id}`);
            }
            if (identity?.kind === "artifact") {
              throw validation(`${id} is an artifact`, `use /api/artifacts/${id}`);
            }
            const view = await getNode(db, id, { facets: DETAIL_FACETS });
            return json(req, nodeToWire(view));
          }),
        PATCH: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              "title",
              "description",
              "priority",
              "size",
              "target",
              "external_ref",
            ]);
            const fields: UpdateFields = {};
            const title = strField(body, "title");
            if (title !== undefined) fields.title = title;
            const description = strField(body, "description");
            if (description !== undefined) fields.description = description;
            const priority = strField(body, "priority");
            if (priority !== undefined) fields.priority = priority as Priority;
            const size = strField(body, "size");
            if (size !== undefined) fields.size = size as Size;
            const target = strField(body, "target");
            if (target !== undefined) fields.target = target;
            const externalRef = strField(body, "external_ref");
            if (externalRef !== undefined) fields.externalRef = externalRef;
            const node = await updateNode(db, await nodeRef(db, req.params.id), fields);
            return echoNode(db, req, node);
          }),
      },

      "/api/nodes/:id/start": {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(db, req, await startTask(db, await nodeRef(db, req.params.id, "task")));
          }),
      },
      "/api/nodes/:id/done": {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              db,
              req,
              await completeTask(db, await nodeRef(db, req.params.id, "task")),
            );
          }),
      },
      "/api/nodes/:id/abandon": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["reason"]);
            const node = await abandonTask(
              db,
              await nodeRef(db, req.params.id, "task"),
              strField(body, "reason"),
            );
            return echoNode(db, req, node);
          }),
      },
      "/api/nodes/:id/park": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["reason"]);
            const node = await parkTask(
              db,
              await nodeRef(db, req.params.id, "task"),
              strField(body, "reason"),
            );
            return echoNode(db, req, node);
          }),
      },
      "/api/nodes/:id/unpark": {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              db,
              req,
              await unparkTask(db, await nodeRef(db, req.params.id, "task")),
            );
          }),
      },
      "/api/nodes/:id/block": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["reason"]);
            const node = await blockTask(
              db,
              await nodeRef(db, req.params.id, "task"),
              strField(body, "reason"),
            );
            return echoNode(db, req, node);
          }),
      },
      "/api/nodes/:id/unblock": {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              db,
              req,
              await unblockTask(db, await nodeRef(db, req.params.id, "task")),
            );
          }),
      },

      "/api/nodes/:id/depend": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["on"]);
            const on = strList(body, "on");
            if (on === undefined || on.length === 0) {
              throw validation("depend requires on");
            }
            const id = await nodeRef(db, req.params.id);
            const onIds = await Promise.all(on.map((t) => nodeRef(db, t)));
            return echoNode(db, req, await depend(db, id, onIds));
          }),
      },
      "/api/nodes/:id/undepend": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["on"]);
            const on = strList(body, "on");
            if (on === undefined || on.length === 0) {
              throw validation("undepend requires on");
            }
            const id = await nodeRef(db, req.params.id);
            const onIds = await Promise.all(on.map((t) => nodeRef(db, t)));
            return echoNode(db, req, await undepend(db, id, onIds));
          }),
      },

      "/api/nodes/:id/move": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["to"]);
            const to = requiredStr(body, "to", "move");
            const node = await moveNode(
              db,
              await nodeRef(db, req.params.id),
              await nodeRef(db, to),
            );
            return echoNode(db, req, node);
          }),
      },
      "/api/nodes/:id/reorder": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["position", "ref", "before", "after"]);
            const before = strField(body, "before");
            const after = strField(body, "after");
            let position = strField(body, "position");
            let ref = strField(body, "ref");
            if (before !== undefined) {
              position = "before";
              ref = before;
            } else if (after !== undefined) {
              position = "after";
              ref = after;
            }
            if (
              position !== "top" &&
              position !== "bottom" &&
              position !== "before" &&
              position !== "after"
            ) {
              throw validation(
                "reorder requires a position",
                'pass {"position":"top"|"bottom"} or {"before":id} / {"after":id}',
              );
            }
            let refId: number | null = null;
            if (position === "before" || position === "after") {
              if (ref === undefined) {
                throw validation("reorder before/after requires ref");
              }
              refId = await nodeRef(db, ref);
            }
            const node = await reorder(
              db,
              await nodeRef(db, req.params.id, "task"),
              position as RankPosition,
              refId,
            );
            return echoNode(db, req, node);
          }),
      },

      "/api/nodes/:id/annotations": {
        GET: (req) =>
          guarded(req, async () => {
            const view = await getNode(db, req.params.id, { facets: ["annotations"] });
            const items = (view.annotations ?? []).map((a) => ({
              content: a.content,
              created_at: a.createdAt,
            }));
            return json(req, { total: items.length, items });
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["content"]);
            const node = await annotate(
              db,
              await nodeRef(db, req.params.id),
              requiredStr(body, "content", "annotate"),
            );
            return echoNode(db, req, node, 201);
          }),
      },

      "/api/nodes/:id/tags/:tag": {
        PUT: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["note"]);
            const id = await nodeRef(db, req.params.id);
            await tagEntities(
              db,
              [{ entityType: "node", entityId: id }],
              [req.params.tag],
              strField(body, "note"),
            );
            const node = await findNodeByRef(db, req.params.id);
            if (node === undefined) {
              throw notFound(`no node ${req.params.id}`);
            }
            return echoNode(db, req, node);
          }),
        DELETE: (req) =>
          guarded(req, async () => {
            const id = await nodeRef(db, req.params.id);
            await untagEntities(db, [{ entityType: "node", entityId: id }], [req.params.tag]);
            const node = await findNodeByRef(db, req.params.id);
            if (node === undefined) {
              throw notFound(`no node ${req.params.id}`);
            }
            return echoNode(db, req, node);
          }),
      },

      "/api/nodes/:id/artifacts": {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["title", "content", "links", "tags"]);
            const anchor = await findNodeByRef(db, req.params.id);
            if (anchor === undefined) {
              throw notFound(`no node ${req.params.id}`);
            }
            const linkNodeIds = [anchor.id];
            for (const token of strList(body, "links") ?? []) {
              const linked = await findNodeByRef(db, token);
              if (linked === undefined) {
                throw notFound(`no node ${token}`);
              }
              if (linked.project_id !== anchor.project_id) {
                throw validation("all attached nodes must be in one project");
              }
              if (!linkNodeIds.includes(linked.id)) {
                linkNodeIds.push(linked.id);
              }
            }
            const { renderedId } = await attachArtifact(db, {
              projectId: anchor.project_id,
              title: requiredStr(body, "title", "attach"),
              content: requiredStr(body, "content", "attach"),
              linkNodeIds,
              tags: strList(body, "tags"),
            });
            const detail = await getArtifact(db, renderedId, { content: true });
            return json(req, artifactToWire(detail), 201);
          }),
      },

      "/api/artifacts": {
        GET: (req) =>
          guarded(req, async () => {
            const q = new URL(req.url).searchParams;
            const opts: Parameters<typeof listArtifacts>[1] = {};
            const project = q.get("project");
            if (project !== null) opts.project = project;
            const tag = q.get("tag");
            if (tag !== null) opts.tag = tag;
            const text = q.get("q");
            if (text !== null) opts.q = text;
            const since = q.get("since");
            if (since !== null) opts.since = normalizeDate(since, "start");
            const before = q.get("before");
            if (before !== null) opts.before = normalizeDate(before, "end");
            const limit = q.get("limit");
            if (limit !== null) {
              const n = Number(limit);
              if (!Number.isInteger(n) || n < 1) {
                throw validation(`invalid limit ${limit}`);
              }
              opts.limit = n;
            }
            const result = await listArtifacts(db, opts);
            return json(req, {
              total: result.total,
              items: result.items.map(artifactSummaryToWire),
            });
          }),
      },

      "/api/artifacts/:id": {
        GET: (req) =>
          guarded(req, async () => {
            const detail = await getArtifact(db, req.params.id, { content: true });
            return json(req, artifactToWire(detail));
          }),
        // The dumb update for an artifact (MMR-40): title only; content is
        // frozen (ADR 0004) and never patchable.
        PATCH: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ["title"]);
            const identity = parseIdentity(req.params.id);
            if (identity?.kind !== "artifact") {
              throw notFound(`no artifact with id ${req.params.id}`);
            }
            const artifact = await findArtifactByRef(db, identity);
            if (artifact === undefined) throw notFound(`no artifact ${req.params.id}`);
            const title = strField(body, "title");
            if (title !== undefined) {
              await updateArtifact(db, artifact.id, { title });
            }
            const detail = await getArtifact(db, req.params.id, { content: true });
            return json(req, artifactToWire(detail));
          }),
      },

      "/api/transitions": {
        GET: (req) =>
          guarded(req, async () => {
            const q = new URL(req.url).searchParams;
            const since = q.get("since") ?? undefined;
            let limit: number | undefined;
            const rawLimit = q.get("limit");
            if (rawLimit !== null) {
              limit = Number(rawLimit);
            }
            const result = await listTransitions(db, { since, limit });
            const body: Record<string, unknown> = { items: result.items };
            if (result.nextCursor !== undefined) {
              body.next_cursor = result.nextCursor;
            }
            return json(req, body);
          }),
      },
    },

    fetch(req) {
      if (req.method === "OPTIONS") {
        return preflight(req);
      }
      const { pathname } = new URL(req.url);
      // Everything outside /api/* is the console's: exact asset, else the
      // SPA fallback (ADR 0013). With no UI built, misses stay 404s.
      if (req.method === "GET" && pathname !== "/api" && !pathname.startsWith("/api/")) {
        const ui = uiResponse(pathname, opts.assets ?? UI_ASSETS);
        if (ui !== null) {
          return ui;
        }
      }
      return json(req, { error: { code: "not_found", message: `no route ${pathname}` } }, 404);
    },
  });
}
