import type {
  FacetName,
  FieldFilter,
  NodeView,
  SeedKind,
  StatusSelector,
  VerdictSelector,
} from '@mimir/contract';
import {
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  QUERY_OP_VALUES,
  SEED_KIND_VALUES,
  SEED_STATUS_SELECTOR_VALUES,
  SIZE_VALUES,
  STATUS_SELECTOR_VALUES,
  VERDICT_VALUES,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';
import type { Server } from 'bun';

import type { DerivationSet, ListOptions, SeedStatusSelector, Store, UpdateFields } from '../core';
import {
  abandonTask,
  annotate,
  archiveProject,
  artifactSummaryToWire,
  artifactToWire,
  attachArtifact,
  blockTask,
  deriveSet,
  fileSeed,
  findNodeInSet,
  asSeedKind,
  getSeed,
  isSeedRef,
  listSeeds,
  promoteSeed,
  promoteToWire,
  seedToWire,
  transitionSeed,
  updateSeed,
  nodeViewOf,
  projectViewByKey,
  projectViewOf,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  renderArtifactRef,
  resolveNodeTokenInSet,
  resolveProjectKeyInSet,
  getArtifact,
  getNode,
  listNodes,
  listProjects,
  moveNode,
  nodeToWire,
  notFound,
  projectNotFound,
  parkTask,
  parseFilterToken,
  parseId,
  parseIdentity,
  projectTree,
  reorder,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
  tagEntities,
  treeToWire,
  unarchiveProject,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
  validation,
} from '../core';
import {
  boolField,
  guarded,
  json,
  preflight,
  readBody,
  requiredStr,
  strField,
  strList,
} from './respond';
import { uiResponse } from './static';
import type { UiAssetMap } from './static';
import { UI_ASSETS } from './ui-assets.generated';

/** A bare `YYYY-MM-DD` filter date → an ISO-ms bound; full timestamps pass through. */
function normalizeDate(value: string, edge: 'start' | 'end'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
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
const SET_FACETS: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts', 'home'];
/** Detail/echo add the artifact inventory (id + title — content stays a sub-resource) and the per-node transition history. */
const DETAIL_FACETS: readonly FacetName[] = [...SET_FACETS, 'artifacts', 'history', 'description'];
/** The project-record projection (verdicts/deps don't apply to a project). */
const PROJECT_FACETS: readonly FacetName[] = ['children', 'distribution', 'tags', 'artifacts'];
/** The project-list projection — the attention facet (MMR-101) + per-project leaf counts (MMR-105) for the project card vitals (MMR-106). */
const PROJECT_LIST_FACETS: readonly FacetName[] = [
  'distribution',
  'tags',
  'attention',
  'leafCounts',
];
/** The archived door adds the artifact tally for the shelf's count line (MMR-125).
 * Scoped to `?status=archived` only: the facet costs an artifact-store read per
 * project, and the active list is polled every 10s by a UI that never reads it. */
const ARCHIVED_LIST_FACETS: readonly FacetName[] = [...PROJECT_LIST_FACETS, 'artifactCount'];

/** Resolve a node token against an already-derived set — the HTTP binding of the
 * core guard, with route pointers. The multi-token twin `nodeRef` uses when a
 * handler resolves several tokens over ONE snapshot (depend/undepend/move). */
function nodeRefIn(set: DerivationSet, token: string, expected = 'node'): number {
  return resolveNodeTokenInSet(set, token, expected, {
    artifact: 'artifacts live at /api/artifacts',
    project: 'projects live at /api/projects',
  });
}

/** Resolve a single node token over its own fresh working-set snapshot (MMR-160,
 * no raw db). Handlers resolving multiple tokens derive one set + `nodeRefIn`. */
async function nodeRef(store: Store, token: string, expected = 'node'): Promise<number> {
  return nodeRefIn(deriveSet(await store.loadWorkingSet()), token, expected);
}

/** The keys of every archived project — the exclude set for the artifact feed (ADR 0015). */
async function archivedProjectKeys(store: Store): Promise<string[]> {
  const ws = await store.loadWorkingSet();
  return ws.projects.filter((p) => p.archived_at !== null).map((p) => p.key);
}

/** Map the `?status` param on the projects list to the listProjects filter (ADR 0015). */
function projectFilter(status: string | null): 'active' | 'archived' | 'all' {
  if (status === 'archived') {
    return 'archived';
  }
  if (status === 'all') {
    return 'all';
  }
  return 'active';
}

/** Validate an optional `upstream` body field as a seed id (`KEY-sN`), MMR-245. */
function upstreamField(body: Record<string, unknown>): string | undefined {
  const upstream = strField(body, 'upstream');
  if (upstream !== undefined && !isSeedRef(upstream)) {
    throw validation(`upstream must be a seed id (KEY-sN), got ${upstream}`);
  }
  return upstream;
}

/** Narrow the required `kind` body field to the closed seed-kind enum (MMR-245),
 * via the core narrowing helper shared with the CLI/MCP boundaries (M4). */
function requireSeedKind(body: Record<string, unknown>): SeedKind {
  const kind = requiredStr(body, 'kind', 'file seed');
  const narrowed = asSeedKind(kind);
  if (narrowed === null) {
    throw validation(`invalid kind: ${kind}`, `kinds: ${SEED_KIND_VALUES.join(', ')}`);
  }
  return narrowed;
}

/** Optional `kind` (a seed PATCH), narrowed to the seed-kind enum when present. */
function optSeedKind(body: Record<string, unknown>): SeedKind | undefined {
  const kind = strField(body, 'kind');
  if (kind === undefined) {
    return undefined;
  }
  const narrowed = asSeedKind(kind);
  if (narrowed === null) {
    throw validation(`invalid kind: ${kind}`, `kinds: ${SEED_KIND_VALUES.join(', ')}`);
  }
  return narrowed;
}

/** Map the `?status` param on the seed queue to the selector (MMR-245). */
function seedStatusParam(status: string | null): SeedStatusSelector | undefined {
  if (status === null) {
    return undefined;
  }
  if (!isMember(status, SEED_STATUS_SELECTOR_VALUES)) {
    throw validation(
      `invalid status: ${status}`,
      `statuses: ${SEED_STATUS_SELECTOR_VALUES.join(', ')}`,
    );
  }
  return status;
}

/** Resolve a project key to its id for the archive/unarchive routes (ADR 0015). */
async function projectIdForArchive(store: Store, key: string): Promise<number> {
  if (parseIdentity(key)?.kind !== 'project') {
    throw validation(`${key} is not a project key`, 'nodes live at /api/nodes/:id');
  }
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/** The write echo — the full updated record, same shape as `GET /api/nodes/:id`. */
async function echoNode(
  store: Store,
  req: Request,
  node: Parameters<typeof nodeViewOf>[1],
  status = 200,
): Promise<Response> {
  const view = await nodeViewOf(store, node, new Set(DETAIL_FACETS));
  return json(req, nodeToWire(view), status);
}

/** A collection body: the envelope object, warnings folded in when present. */
function setBody(total: number, items: NodeView[], warnings?: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = { items: items.map(nodeToWire), total };
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
  const type = q.get('type');
  if (type !== null) {
    filters.push(parseFilterToken('in', `type:${type}`));
  } else if (!filters.some((f) => f.field === 'type')) {
    // No type selection → the whole tree, not the intent layer's tasks-only default.
    filters.push({ field: 'type', op: 'in', value: NODE_TYPE_VALUES.join(',') });
  }
  const priority = q.get('priority');
  if (priority !== null) {
    filters.push(parseFilterToken('eq', `priority:${priority}`));
  }
  const size = q.get('size');
  if (size !== null) {
    filters.push(parseFilterToken('eq', `size:${size}`));
  }

  const verdicts: VerdictSelector[] = [];
  for (const [param, negate] of [
    ['is', false],
    ['not-is', true],
  ] as const) {
    for (const raw of q.getAll(param)) {
      for (const token of raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)) {
        if (!isMember(token, VERDICT_VALUES)) {
          throw validation(`unknown verdict ${token}`, `verdicts: ${VERDICT_VALUES.join(', ')}`);
        }
        verdicts.push({ negate, verdict: token });
      }
    }
  }

  const opts: ListOptions = { facets: SET_FACETS, filters, verdicts };
  const scope = q.get('project');
  if (scope !== null) {
    opts.scope = scope;
  }
  const tag = q.get('tag');
  if (tag !== null) {
    opts.tag = tag;
  }
  const qText = q.get('q');
  if (qText !== null && qText !== '') {
    opts.q = qText;
  }
  const limit = q.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) {
      throw validation(`invalid limit ${limit}`);
    }
    opts.limit = n;
  }
  // `status` accepts one selector or a comma-separated union (MMR-228 — the
  // tasks browser's multi-status filter); a single value keeps its exact
  // pre-union semantics. Any bad token voids the whole selection (warning path).
  const status = q.get('status');
  if (status !== null) {
    const tokens = status
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    if (tokens.length === 0) {
      return { badStatus: status, opts };
    }
    const selectors: StatusSelector[] = [];
    for (const token of tokens) {
      if (!isMember(token, STATUS_SELECTOR_VALUES)) {
        return { badStatus: token, opts };
      }
      selectors.push(token);
    }
    const [only] = selectors;
    opts.status = selectors.length === 1 && only !== undefined ? only : selectors;
  }
  return { opts };
}

export type ServeOptions = {
  port: number;
  /** Reported by /api/health — how `service status` asks a live process what it is. */
  version: string;
  /** The embedded-UI manifest; tests inject fixtures, prod uses the generated map. */
  assets?: UiAssetMap;
  /** The MMR-53 walk-upward convenience; the daemon posture passes false (declared port, loud failure). */
  hunt?: boolean;
};

/** How far past a taken port the hunt walks before giving up (MMR-53). */
export const PORT_HUNT_SPAN = 20;

/** Bun's bind-collision error — the only one the hunt may swallow. */
function isPortTaken(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';
}

/**
 * Build and start the server. Binds `127.0.0.1` unconditionally — the
 * loopback-only posture is the architecture, not a default (ADR 0012). A taken
 * port hunts upward (+1 … +`PORT_HUNT_SPAN`) to the next free one — a dev
 * convenience; a supervised deployment pins the port and the proxy points at
 * it. Callers must surface the bound port: it may differ from the request.
 */
export function createServer(store: Store, opts: ServeOptions): Server<undefined> {
  const last = Math.min(opts.port + PORT_HUNT_SPAN, 65535);
  for (let port = opts.port; ; port++) {
    try {
      return bindServer(store, opts, port);
    } catch (err) {
      if (!isPortTaken(err) || opts.port === 0 || opts.hunt === false) {
        throw err;
      }
      if (port >= last) {
        throw Object.assign(
          new Error(`ports ${String(opts.port)}–${String(last)} are all in use`),
          {
            code: 'EADDRINUSE',
          },
        );
      }
    }
  }
}

function bindServer(store: Store, opts: ServeOptions, port: number): Server<undefined> {
  return Bun.serve({
    fetch(req) {
      if (req.method === 'OPTIONS') {
        return preflight(req);
      }
      const { pathname } = new URL(req.url);
      // Everything outside /api/* is the console's: exact asset, else the
      // SPA fallback (ADR 0013). With no UI built, misses stay 404s.
      if (req.method === 'GET' && pathname !== '/api' && !pathname.startsWith('/api/')) {
        const ui = uiResponse(pathname, opts.assets ?? UI_ASSETS);
        if (ui !== null) {
          return ui;
        }
      }
      return json(req, { error: { code: 'not_found', message: `no route ${pathname}` } }, 404);
    },
    hostname: '127.0.0.1',
    port,
    routes: {
      '/api/artifacts': {
        GET: (req) =>
          guarded(req, async () => {
            const q = new URL(req.url).searchParams;
            const listOpts: Parameters<Store['artifacts']['list']>[0] = {};
            const project = q.get('project');
            if (project !== null) {
              listOpts.project = project;
            }
            const tag = q.get('tag');
            if (tag !== null) {
              listOpts.tag = tag;
            }
            const text = q.get('q');
            if (text !== null) {
              listOpts.q = text;
            }
            const since = q.get('since');
            if (since !== null) {
              listOpts.since = normalizeDate(since, 'start');
            }
            const before = q.get('before');
            if (before !== null) {
              listOpts.before = normalizeDate(before, 'end');
            }
            const limit = q.get('limit');
            if (limit !== null) {
              const n = Number(limit);
              if (!Number.isInteger(n) || n < 1) {
                throw validation(`invalid limit ${limit}`);
              }
              listOpts.limit = n;
            }
            // Archived projects' artifacts read as absent (ADR 0015); archived
            // state lives with the node backend, so the caller supplies the keys.
            listOpts.excludeProjects = await archivedProjectKeys(store);
            const result = await store.artifacts.list(listOpts);
            return json(req, {
              items: result.items.map((r) =>
                artifactSummaryToWire({
                  createdAt: r.created_at,
                  id: renderArtifactRef({ key: r.key, seq: r.seq }),
                  project: r.key,
                  tags: r.tags,
                  title: r.title,
                }),
              ),
              total: result.total,
            });
          }),
      },

      '/api/artifacts/:id': {
        GET: (req) =>
          guarded(req, async () => {
            const detail = await getArtifact(store, req.params.id, { content: true });
            return json(req, artifactToWire(detail));
          }),
        // The dumb update for an artifact (MMR-40): title only; content is
        // frozen (ADR 0004) and never patchable.
        PATCH: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['title']);
            const identity = parseIdentity(req.params.id);
            if (identity?.kind !== 'artifact') {
              throw notFound(`no artifact with id ${req.params.id}`);
            }
            const title = strField(body, 'title');
            if (title !== undefined) {
              await updateArtifact(store, { key: identity.key, seq: identity.seq }, { title });
            }
            const detail = await getArtifact(store, req.params.id, { content: true });
            return json(req, artifactToWire(detail));
          }),
      },

      '/api/health': {
        GET: (req) => json(req, { status: 'ok', version: opts.version }),
      },

      '/api/nodes': {
        GET: (req) =>
          guarded(req, async () => {
            const { opts: nodeOpts, badStatus } = parseNodesQuery(new URL(req.url));
            if (badStatus !== undefined) {
              return json(req, {
                items: [],
                total: 0,
                warnings: [
                  {
                    code: 'no_match_value',
                    expected: [...STATUS_SELECTOR_VALUES],
                    field: 'status',
                    message: `${badStatus} is not a status`,
                    value: badStatus,
                  },
                ],
              });
            }
            const result = await listNodes(store, nodeOpts);
            return json(req, setBody(result.total, result.items, result.warnings));
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              'type',
              'parent',
              'title',
              'description',
              'summary',
              'target',
              'priority',
              'size',
              'external_ref',
              'upstream',
              'open_ended',
              'tags',
            ]);
            const type = requiredStr(body, 'type', 'create');
            const parent = requiredStr(body, 'parent', 'create');
            const title = requiredStr(body, 'title', 'create');
            const description = strField(body, 'description');
            const summary = strField(body, 'summary');
            const tags = strList(body, 'tags');
            // open_ended is container-only — reject it on task create (symmetry with
            // PATCH, which rejects it on a task; MMR-204). initiative/phase consume it.
            if (type === 'task' && boolField(body, 'open_ended') !== undefined) {
              throw validation('open_ended applies only to phases and initiatives');
            }
            if (type === 'initiative') {
              if (parseId(parent) !== null) {
                throw validation("an initiative's parent must be a project (KEY)");
              }
              const node = await createInitiative(store, {
                description,
                openEnded: boolField(body, 'open_ended'),
                projectId: resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), parent),
                summary,
                tags,
                title,
              });
              return echoNode(store, req, node, 201);
            }
            if (type === 'phase') {
              const node = await createPhase(store, {
                description,
                openEnded: boolField(body, 'open_ended'),
                parentId: await nodeRef(store, parent, 'initiative'),
                summary,
                tags,
                target: strField(body, 'target'),
                title,
              });
              return echoNode(store, req, node, 201);
            }
            if (type === 'task') {
              const priority = strField(body, 'priority');
              if (priority !== undefined && !isMember(priority, PRIORITY_VALUES)) {
                throw validation(
                  `invalid priority: ${priority}`,
                  `priorities: ${PRIORITY_VALUES.join(', ')}`,
                );
              }
              const size = strField(body, 'size');
              if (size !== undefined && !isMember(size, SIZE_VALUES)) {
                throw validation(`invalid size: ${size}`, `sizes: ${SIZE_VALUES.join(', ')}`);
              }
              const node = await createTask(store, {
                description,
                externalRef: strField(body, 'external_ref'),
                parentId: await nodeRef(store, parent, 'phase or initiative'),
                priority,
                size,
                summary,
                tags,
                title,
                upstream: upstreamField(body),
              });
              return echoNode(store, req, node, 201);
            }
            throw validation(
              `create: unknown type ${type}`,
              'types: initiative, phase, task — projects via POST /api/projects',
            );
          }),
      },

      '/api/nodes/:id': {
        GET: (req) =>
          guarded(req, async () => {
            const id = req.params.id;
            const identity = parseIdentity(id);
            if (identity?.kind === 'project') {
              throw validation(`${id} is a project`, `use /api/projects/${id}`);
            }
            if (identity?.kind === 'artifact') {
              throw validation(`${id} is an artifact`, `use /api/artifacts/${id}`);
            }
            const view = await getNode(store, id, { facets: DETAIL_FACETS });
            return json(req, nodeToWire(view));
          }),
        PATCH: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              'title',
              'description',
              'summary',
              'priority',
              'size',
              'target',
              'external_ref',
              'upstream',
              'open_ended',
            ]);
            const fields: UpdateFields = {};
            const title = strField(body, 'title');
            if (title !== undefined) {
              fields.title = title;
            }
            const description = strField(body, 'description');
            if (description !== undefined) {
              fields.description = description;
            }
            const summary = strField(body, 'summary');
            if (summary !== undefined) {
              fields.summary = summary;
            }
            const priority = strField(body, 'priority');
            if (priority !== undefined) {
              if (!isMember(priority, PRIORITY_VALUES)) {
                throw validation(
                  `invalid priority: ${priority}`,
                  `priorities: ${PRIORITY_VALUES.join(', ')}`,
                );
              }
              fields.priority = priority;
            }
            const size = strField(body, 'size');
            if (size !== undefined) {
              if (!isMember(size, SIZE_VALUES)) {
                throw validation(`invalid size: ${size}`, `sizes: ${SIZE_VALUES.join(', ')}`);
              }
              fields.size = size;
            }
            const target = strField(body, 'target');
            if (target !== undefined) {
              fields.target = target;
            }
            const externalRef = strField(body, 'external_ref');
            if (externalRef !== undefined) {
              fields.externalRef = externalRef;
            }
            const upstream = upstreamField(body);
            if (upstream !== undefined) {
              fields.upstream = upstream;
            }
            const openEnded = boolField(body, 'open_ended');
            if (openEnded !== undefined) {
              fields.openEnded = openEnded;
            }
            const node = await updateNode(store, await nodeRef(store, req.params.id), fields);
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/abandon': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const node = await abandonTask(
              store,
              await nodeRef(store, req.params.id, 'task'),
              strField(body, 'reason'),
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/annotations': {
        GET: (req) =>
          guarded(req, async () => {
            const view = await getNode(store, req.params.id, { facets: ['annotations'] });
            const items = (view.annotations ?? []).map((a) => ({
              content: a.content,
              created_at: a.createdAt,
            }));
            return json(req, { items, total: items.length });
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['content']);
            const node = await annotate(
              store,
              await nodeRef(store, req.params.id),
              requiredStr(body, 'content', 'annotate'),
            );
            return echoNode(store, req, node, 201);
          }),
      },

      '/api/nodes/:id/artifacts': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['title', 'content', 'links', 'tags']);
            const set = deriveSet(await store.loadWorkingSet());
            const anchor = findNodeInSet(set, req.params.id);
            if (anchor === undefined) {
              throw notFound(`${req.params.id} doesn't exist`);
            }
            const linkNodeIds = [anchor.id];
            for (const token of strList(body, 'links') ?? []) {
              const linked = findNodeInSet(set, token);
              if (linked === undefined) {
                throw notFound(`${token} doesn't exist`);
              }
              if (linked.project_id !== anchor.project_id) {
                throw validation('all the links must be in one project');
              }
              if (!linkNodeIds.includes(linked.id)) {
                linkNodeIds.push(linked.id);
              }
            }
            const { renderedId } = await attachArtifact(store, {
              content: requiredStr(body, 'content', 'attach'),
              linkNodeIds,
              projectId: anchor.project_id,
              tags: strList(body, 'tags'),
              title: requiredStr(body, 'title', 'attach'),
            });
            const detail = await getArtifact(store, renderedId, { content: true });
            return json(req, artifactToWire(detail), 201);
          }),
      },

      '/api/nodes/:id/block': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const node = await blockTask(
              store,
              await nodeRef(store, req.params.id, 'task'),
              strField(body, 'reason'),
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/depend': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['on']);
            const on = strList(body, 'on');
            if (on === undefined || on.length === 0) {
              throw validation('depend requires on');
            }
            const set = deriveSet(await store.loadWorkingSet());
            const id = nodeRefIn(set, req.params.id);
            const onIds = on.map((t) => nodeRefIn(set, t));
            return echoNode(store, req, await depend(store, id, onIds));
          }),
      },

      '/api/nodes/:id/done': {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              store,
              req,
              await completeTask(store, await nodeRef(store, req.params.id, 'task')),
            );
          }),
      },

      '/api/nodes/:id/move': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['to']);
            const to = requiredStr(body, 'to', 'move');
            const set = deriveSet(await store.loadWorkingSet());
            const node = await moveNode(store, nodeRefIn(set, req.params.id), nodeRefIn(set, to));
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/park': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const node = await parkTask(
              store,
              await nodeRef(store, req.params.id, 'task'),
              strField(body, 'reason'),
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/reopen': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const node = await reopenTask(
              store,
              await nodeRef(store, req.params.id, 'task'),
              strField(body, 'reason'),
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/reorder': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['position', 'ref', 'before', 'after']);
            const before = strField(body, 'before');
            const after = strField(body, 'after');
            let position = strField(body, 'position');
            let ref = strField(body, 'ref');
            if (before !== undefined) {
              position = 'before';
              ref = before;
            } else if (after !== undefined) {
              position = 'after';
              ref = after;
            }
            if (
              position !== 'top' &&
              position !== 'bottom' &&
              position !== 'before' &&
              position !== 'after'
            ) {
              throw validation(
                'reorder requires a position',
                'pass {"position":"top"|"bottom"} or {"before":id} / {"after":id}',
              );
            }
            let refId: number | null = null;
            if (position === 'before' || position === 'after') {
              if (ref === undefined) {
                throw validation('reorder before/after requires ref');
              }
              refId = await nodeRef(store, ref);
            }
            const node = await reorder(
              store,
              await nodeRef(store, req.params.id, 'task'),
              position,
              refId,
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/return': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const node = await returnTask(
              store,
              await nodeRef(store, req.params.id, 'task'),
              strField(body, 'reason'),
            );
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/start': {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              store,
              req,
              await startTask(store, await nodeRef(store, req.params.id, 'task')),
            );
          }),
      },

      '/api/nodes/:id/submit': {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              store,
              req,
              await submitTask(store, await nodeRef(store, req.params.id, 'task')),
            );
          }),
      },

      '/api/nodes/:id/tags/:tag': {
        DELETE: (req) =>
          guarded(req, async () => {
            const id = await nodeRef(store, req.params.id);
            await untagEntities(store, [{ entityId: id, entityType: 'node' }], [req.params.tag]);
            const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), req.params.id);
            if (node === undefined) {
              throw notFound(`${req.params.id} doesn't exist`);
            }
            return echoNode(store, req, node);
          }),
        PUT: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['note']);
            const id = await nodeRef(store, req.params.id);
            await tagEntities(
              store,
              [{ entityId: id, entityType: 'node' }],
              [req.params.tag],
              strField(body, 'note'),
            );
            const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), req.params.id);
            if (node === undefined) {
              throw notFound(`${req.params.id} doesn't exist`);
            }
            return echoNode(store, req, node);
          }),
      },

      '/api/nodes/:id/unblock': {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              store,
              req,
              await unblockTask(store, await nodeRef(store, req.params.id, 'task')),
            );
          }),
      },

      '/api/nodes/:id/undepend': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['on']);
            const on = strList(body, 'on');
            if (on === undefined || on.length === 0) {
              throw validation('undepend requires on');
            }
            const set = deriveSet(await store.loadWorkingSet());
            const id = nodeRefIn(set, req.params.id);
            const onIds = on.map((t) => nodeRefIn(set, t));
            return echoNode(store, req, await undepend(store, id, onIds));
          }),
      },

      '/api/nodes/:id/unpark': {
        POST: (req) =>
          guarded(req, async () => {
            await readBody(req, []);
            return echoNode(
              store,
              req,
              await unparkTask(store, await nodeRef(store, req.params.id, 'task')),
            );
          }),
      },

      '/api/projects': {
        GET: (req) =>
          guarded(req, async () => {
            // Archived projects are hidden by default; ?status=archived is the
            // door (ADR 0015), ?status=all returns both.
            const filter = projectFilter(new URL(req.url).searchParams.get('status'));
            const items = await listProjects(
              store,
              filter === 'archived' ? ARCHIVED_LIST_FACETS : PROJECT_LIST_FACETS,
              filter,
            );
            return json(req, setBody(items.length, items));
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['key', 'name', 'description', 'tags']);
            const project = await createProject(store, {
              description: strField(body, 'description'),
              key: requiredStr(body, 'key', 'create project'),
              name: requiredStr(body, 'name', 'create project'),
              tags: strList(body, 'tags'),
            });
            const view = await getNode(store, project.key, { facets: PROJECT_FACETS });
            return json(req, nodeToWire(view), 201);
          }),
      },

      '/api/projects/:key': {
        GET: (req) =>
          guarded(req, async () => {
            const key = req.params.key;
            if (parseIdentity(key)?.kind !== 'project') {
              throw validation(`${key} is not a project key`, 'nodes live at /api/nodes/:id');
            }
            const view = await getNode(store, key, { facets: PROJECT_FACETS });
            return json(req, nodeToWire(view));
          }),
        PATCH: (req) =>
          guarded(req, async () => {
            const key = req.params.key;
            if (parseIdentity(key)?.kind !== 'project') {
              throw validation(`${key} is not a project key`, 'nodes live at /api/nodes/:id');
            }
            const body = await readBody(req, ['name', 'title', 'description']);
            // Accept both `name` and `title` as the project name field
            // (`title` follows the NodeView wire name; `name` is the native field).
            const name = strField(body, 'name') ?? strField(body, 'title');
            const description = strField(body, 'description');
            const projectId = resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
            await updateProject(store, projectId, { description, name });
            const view = await projectViewByKey(store, key, new Set(PROJECT_FACETS));
            if (view === undefined) {
              throw projectNotFound(key);
            }
            return json(req, nodeToWire(view));
          }),
      },

      // Project archive (ADR 0015). The echo builds the view directly from the
      // returned row — getNode would 404 on the now-archived project. Route keys
      // stay alphabetically sorted (archive < tree < unarchive).
      '/api/projects/:key/archive': {
        POST: (req) =>
          guarded(req, async () => {
            const id = await projectIdForArchive(store, req.params.key);
            const body = await readBody(req, ['reason']);
            const project = await archiveProject(store, id, strField(body, 'reason'));
            return json(
              req,
              nodeToWire(await projectViewOf(store, project, new Set(PROJECT_FACETS))),
            );
          }),
      },

      '/api/projects/:key/tree': {
        GET: (req) =>
          guarded(req, async () => {
            const key = req.params.key;
            if (parseIdentity(key)?.kind !== 'project') {
              throw validation(`${key} is not a project key`);
            }
            return json(req, treeToWire(await projectTree(store, key)));
          }),
      },

      '/api/projects/:key/unarchive': {
        POST: (req) =>
          guarded(req, async () => {
            const id = await projectIdForArchive(store, req.params.key);
            const project = await unarchiveProject(store, id);
            return json(
              req,
              nodeToWire(await projectViewOf(store, project, new Set(PROJECT_FACETS))),
            );
          }),
      },

      '/api/seeds': {
        GET: (req) =>
          guarded(req, async () => {
            const q = new URL(req.url).searchParams;
            const listOpts: Parameters<typeof listSeeds>[1] = {};
            const project = q.get('project');
            if (project !== null) {
              listOpts.project = project;
            }
            // An empty `?requester=` is an absent filter, not a filter for the
            // empty string — the whole queue, not zero rows (B5c).
            const requester = q.get('requester');
            if (requester !== null && requester !== '') {
              listOpts.requester = requester;
            }
            const status = seedStatusParam(q.get('status'));
            if (status !== undefined) {
              listOpts.status = status;
            }
            const sort = q.get('sort');
            if (sort !== null) {
              if (sort !== 'asc' && sort !== 'desc') {
                throw validation(`invalid sort: ${sort}`, 'sort is asc or desc');
              }
              listOpts.sort = sort;
            }
            const seeds = await listSeeds(store, listOpts);
            return json(req, { items: seeds.map(seedToWire), total: seeds.length });
          }),
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              'project',
              'title',
              'kind',
              'description',
              'requester',
            ]);
            const seed = await fileSeed(store, {
              description: strField(body, 'description'),
              kind: requireSeedKind(body),
              project: requiredStr(body, 'project', 'file seed'),
              requester: strField(body, 'requester') ?? null,
              title: requiredStr(body, 'title', 'file seed'),
            });
            return json(req, seedToWire(seed), 201);
          }),
      },

      '/api/seeds/:id': {
        GET: (req) =>
          guarded(req, async () =>
            json(req, seedToWire(await getSeed(store, req.params.id, { content: true }))),
          ),
        // The dumb seed patch (MMR-245): title/kind/description on a LIVE seed;
        // the store refuses a terminal (frozen) seed. requester/spawned are
        // verb-owned and never patched here.
        PATCH: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['title', 'kind', 'description']);
            const fields: Parameters<typeof updateSeed>[2] = {};
            const title = strField(body, 'title');
            if (title !== undefined) {
              fields.title = title;
            }
            const description = strField(body, 'description');
            if (description !== undefined) {
              fields.description = description;
            }
            const kind = optSeedKind(body);
            if (kind !== undefined) {
              fields.kind = kind;
            }
            return json(req, seedToWire(await updateSeed(store, req.params.id, fields)));
          }),
      },

      '/api/seeds/:id/promote': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, [
              'parent',
              'link',
              'title',
              'description',
              'priority',
              'size',
              'tags',
            ]);
            const priority = strField(body, 'priority');
            if (priority !== undefined && !isMember(priority, PRIORITY_VALUES)) {
              throw validation(
                `invalid priority: ${priority}`,
                `priorities: ${PRIORITY_VALUES.join(', ')}`,
              );
            }
            const size = strField(body, 'size');
            if (size !== undefined && !isMember(size, SIZE_VALUES)) {
              throw validation(`invalid size: ${size}`, `sizes: ${SIZE_VALUES.join(', ')}`);
            }
            const { created, seed } = await promoteSeed(store, req.params.id, {
              description: strField(body, 'description'),
              link: strField(body, 'link'),
              parent: strField(body, 'parent'),
              priority,
              size,
              tags: strList(body, 'tags'),
              title: strField(body, 'title'),
            });
            // `created` rides as a sibling of the seed wire (not a re-wrap), so the
            // response surfaces the spawned task id in create mode (B7).
            return json(req, promoteToWire(seed, created));
          }),
      },

      '/api/seeds/:id/reject': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const seed = await transitionSeed(
              store,
              req.params.id,
              'rejected',
              requiredStr(body, 'reason', 'reject'),
            );
            return json(req, seedToWire(seed));
          }),
      },

      '/api/seeds/:id/resolve': {
        POST: (req) =>
          guarded(req, async () => {
            const body = await readBody(req, ['reason']);
            const seed = await transitionSeed(
              store,
              req.params.id,
              'resolved',
              requiredStr(body, 'reason', 'resolve'),
            );
            return json(req, seedToWire(seed));
          }),
      },

      '/api/transitions': {
        GET: (req) =>
          guarded(req, async () => {
            const q = new URL(req.url).searchParams;
            // An empty `?since=` is an absent cursor, not the cursor `''` — the
            // two backends decode `''` divergently (SQLite from-start, Norn throws).
            const since = q.get('since') || undefined;
            let limit: number | undefined;
            const rawLimit = q.get('limit');
            if (rawLimit !== null) {
              limit = Number(rawLimit);
            }
            const result = await store.transitions.list({ limit, since });
            const body: Record<string, unknown> = { items: result.items };
            if (result.nextCursor !== undefined) {
              body.next_cursor = result.nextCursor;
            }
            return json(req, body);
          }),
      },
    },
  });
}
