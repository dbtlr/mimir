import {
  CHEAP_FACETS,
  QUERY_OP_VALUES,
  SEED_KIND_VALUES,
  WRITE_ECHO_FACETS,
} from '@mimir/contract';
import type {
  FacetName,
  FieldFilter,
  Priority,
  QueryOp,
  SeedKind,
  Size,
  StatusSelector,
  UniformVerb,
  Verdict,
  VerdictSelector,
} from '@mimir/contract';

import {
  MimirError,
  annotate,
  applyUpdateFields,
  asSeedKind,
  attachArtifact,
  deriveSet,
  nodeViewOf,
  projectViewByKey,
  projectViewOf,
  createNode,
  createScratchpadService,
  depend,
  fileSeed,
  getSeed,
  inapplicableUpdateFields,
  isFilterDate,
  listSeeds,
  OPS,
  parsePriorityValue,
  parseSizeValue,
  parseWireField,
  promoteSeed,
  transitionSeed,
  resolveBoard,
  triage,
  updateSeed,
  resolveAttachTargets,
  resolveNodeTokenInSet,
  resolveProjectKeyInSet,
  formatArtifactJson,
  formatArtifactSetJson,
  formatNodeJson,
  formatOverviewJson,
  formatPromoteJson,
  formatSeedJson,
  formatSeedsJson,
  formatSetJson,
  formatStatusJson,
  formatTriageJson,
  scratchpadReceiptToWire,
  scratchpadToWire,
  getArtifact,
  getNode,
  listArtifacts,
  listNodes,
  listProjects,
  moveNode,
  nextTasks,
  overviewOf,
  notFound,
  projectNotFound,
  reorder,
  resolveEntityTokenInSet,
  specUpdateFields,
  statusOfNode,
  tagEntities,
  undepend,
  untagEntities,
  updateArtifact,
  updateNode,
  parseFilterToken,
  parseIdentity,
  updateProject,
  validation,
} from '../core';
import type {
  ArtifactUpdateFields,
  DerivationSet,
  RankPosition,
  SeedStatusSelector,
  SpecUpdateKey,
  Store,
  UpdateFields,
  UpdateProjectFields,
  UpdateSeedFields,
} from '../core';

/**
 * The MCP tool handlers — the agent envelope over the shared intent layer.
 * Token-conscious: results are the structured `json` rendering (the same wire
 * contract the CLI emits). Kept as plain functions so they can be tested
 * against a real DB without standing up a transport.
 */

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  // The SDK's CallToolResult carries an open index signature; matching it keeps
  // these handlers assignable as tool callbacks.
  [key: string]: unknown;
};

const ok = (text: string): ToolResult => ({ content: [{ text, type: 'text' }] });

/** The structured MCP error envelope `{"error":{code,message,hint?}}` as an
 * `isError` tool result — the shared emitter for tool-level faults and the
 * input-schema voice guard (server.ts). */
export const toolErrorResult = (code: string, message: string, hint?: string): ToolResult => ({
  content: [
    {
      text: JSON.stringify(
        hint === undefined ? { error: { code, message } } : { error: { code, hint, message } },
      ),
      type: 'text',
    },
  ],
  isError: true,
});
const fail = toolErrorResult;

type ScratchpadMutationArgs = { id: string; expected_updated_at: string };

export type ScratchCreateToolArgs = { scope: string; title: string; linked_work?: string[] };
export type ScratchListToolArgs = { scope?: string };
export type ScratchUpdateToolArgs = ScratchpadMutationArgs & {
  title?: string;
  linked_work?: string[];
};

const scratchService = (store: Store) =>
  createScratchpadService(store.scratchpads, store.artifacts);

export function toolScratchCreate(store: Store, args: ScratchCreateToolArgs): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).create({
      anchors: args.linked_work,
      project: args.scope,
      title: args.title,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchList(store: Store, args: ScratchListToolArgs): Promise<ToolResult> {
  return guard(async () => {
    const scratchpads = (await scratchService(store).list(args.scope)).toSorted(
      (a, b) =>
        Number(b.freezingAt !== null) - Number(a.freezingAt !== null) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
    return ok(
      JSON.stringify(
        {
          scratchpads: scratchpads.map((scratchpad) => ({
            ...scratchpadReceiptToWire(scratchpad),
            state: scratchpad.freezingAt === null ? 'active' : 'freezing',
          })),
          total: scratchpads.length,
        },
        null,
        2,
      ),
    );
  });
}

export function toolScratchGet(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () =>
    ok(JSON.stringify(scratchpadToWire(await scratchService(store).get(args.id)), null, 2)),
  );
}

export function toolScratchUpdate(store: Store, args: ScratchUpdateToolArgs): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).updateMetadata(args.id, {
      anchors: args.linked_work,
      expectedUpdatedAt: args.expected_updated_at,
      title: args.title,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchCheckpoint(
  store: Store,
  args: ScratchpadMutationArgs & { content: string },
): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).checkpoint(args.id, {
      content: args.content,
      expectedUpdatedAt: args.expected_updated_at,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchAgendaAdd(
  store: Store,
  args: ScratchpadMutationArgs & { content: string },
): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).agendaAdd(args.id, {
      content: args.content,
      expectedUpdatedAt: args.expected_updated_at,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchAgendaComplete(
  store: Store,
  args: ScratchpadMutationArgs & { number: number },
): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).agendaComplete(args.id, {
      expectedUpdatedAt: args.expected_updated_at,
      number: args.number,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchAgendaSupersede(
  store: Store,
  args: ScratchpadMutationArgs & { number: number; reason: string },
): Promise<ToolResult> {
  return guard(async () => {
    const scratchpad = await scratchService(store).agendaSupersede(args.id, {
      expectedUpdatedAt: args.expected_updated_at,
      number: args.number,
      reason: args.reason,
    });
    return ok(JSON.stringify(scratchpadReceiptToWire(scratchpad), null, 2));
  });
}

export function toolScratchFreeze(
  store: Store,
  args: ScratchpadMutationArgs & { summary: string; tags?: string[] },
): Promise<ToolResult> {
  return guard(async () => {
    const artifact = await scratchService(store).freeze(args.id, {
      expectedUpdatedAt: args.expected_updated_at,
      summary: args.summary,
      tags: args.tags,
    });
    return ok(
      JSON.stringify(
        {
          created_at: artifact.created_at,
          id: `${artifact.key}-a${String(artifact.seq)}`,
          linked_work: artifact.links,
          project: artifact.key,
          summary: artifact.summary,
          tags: artifact.tags,
          title: artifact.title,
        },
        null,
        2,
      ),
    );
  });
}

export function toolScratchDiscard(
  store: Store,
  args: ScratchpadMutationArgs & { force?: boolean; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    await scratchService(store).discard(args.id, {
      expectedUpdatedAt: args.expected_updated_at,
      force: args.force,
      reason: args.reason,
    });
    return ok(JSON.stringify({ id: args.id, result: 'discarded' }, null, 2));
  });
}

/** Map a thrown {@link MimirError} to a structured `isError` result; rethrow anything else. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MimirError) {
      return fail(error.code, error.message, error.hint);
    }
    throw error;
  }
}

/** Resolve a node token against an already-derived set — the multi-token twin
 * `nodeId` uses when a handler resolves several tokens over ONE snapshot. */
function nodeIdIn(set: DerivationSet, id: string, expected = 'node'): string {
  return resolveNodeTokenInSet(set, id, expected);
}

/** Resolve a node token over its own fresh working-set snapshot (MMR-160, no raw
 * db). Handlers resolving multiple tokens derive one set + `nodeIdIn`. */
async function nodeId(store: Store, id: string, expected = 'node'): Promise<string> {
  return nodeIdIn(deriveSet(await store.loadWorkingSet()), id, expected);
}

/**
 * Resolve a bare project KEY to its canonical identity over the working set.
 * Throws not_found if no project with that key exists.
 */
async function projectId(store: Store, key: string): Promise<string> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/** The write-echo facet set — {@link WRITE_ECHO_FACETS}, as a `Set` for the echo seams below. */
const WRITE_ECHO_FACET_SET: ReadonlySet<FacetName> = new Set(WRITE_ECHO_FACETS);

/**
 * Echo a returned Node row as bare JSON (the mutation echo contract, shared
 * with the CLI's `WRITE_ECHO_FACETS`, ADR 0003).
 * Accepts the Node row returned directly by mutation verbs — no reload needed.
 * Typed via `Parameters` to avoid importing the `Node` row type directly.
 */
async function echoNode(store: Store, node: Parameters<typeof nodeViewOf>[1]): Promise<ToolResult> {
  return ok(formatNodeJson(await nodeViewOf(store, node, WRITE_ECHO_FACET_SET)));
}

/**
 * Echo a returned Project row as bare JSON — the project half of the mutation
 * echo contract, through the same {@link WRITE_ECHO_FACETS} as nodes so a
 * project's echoed rollup covers its real root children (MMR-242).
 */
async function echoProject(
  store: Store,
  project: Parameters<typeof projectViewOf>[1],
): Promise<ToolResult> {
  return ok(formatNodeJson(await projectViewOf(store, project, WRITE_ECHO_FACET_SET)));
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/** The set-selection args shared by `next` and `list` (MMR-33) — named arrays per operator. */
export type SetQueryArgs = {
  scope?: string;
  status?: StatusSelector;
  is?: Verdict[];
  notIs?: Verdict[];
  eq?: string[];
  notEq?: string[];
  in?: string[];
  notIn?: string[];
  has?: string[];
  missing?: string[];
  before?: string[];
  on?: string[];
  after?: string[];
  notBefore?: string[];
  notAfter?: string[];
  priority?: Priority;
  size?: Size;
  tag?: string;
  limit?: number;
};

/**
 * The op → {@link SetQueryArgs} key mapping — a `Record` keyed by the full
 * `QueryOp` union (MMR-306), so an operator the contract adds is a compile
 * error here until this map names its arg key, never a silently-missed
 * transport. The CLI needs no equivalent map: its flags are spelled
 * identically to the op (`run.ts`'s `parseFilters`).
 */
const OP_ARG_KEYS: Record<QueryOp, keyof SetQueryArgs> = {
  after: 'after',
  before: 'before',
  eq: 'eq',
  has: 'has',
  in: 'in',
  missing: 'missing',
  'not-after': 'notAfter',
  'not-before': 'notBefore',
  'not-eq': 'notEq',
  'not-in': 'notIn',
  on: 'on',
};

function collectFilters(args: SetQueryArgs): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const op of QUERY_OP_VALUES) {
    const tokens = args[OP_ARG_KEYS[op]];
    if (!Array.isArray(tokens)) {
      continue;
    }
    for (const token of tokens) {
      filters.push(parseFilterToken(op, token));
    }
  }
  return filters;
}

function collectVerdicts(args: SetQueryArgs): VerdictSelector[] {
  return [
    ...(args.is ?? []).map((verdict) => ({ negate: false, verdict })),
    ...(args.notIs ?? []).map((verdict) => ({ negate: true, verdict })),
  ];
}

export function toolNext(store: Store, args: SetQueryArgs): Promise<ToolResult> {
  return guard(async () => {
    const result = await nextTasks(store, {
      filters: collectFilters(args),
      limit: args.limit,
      priority: args.priority,
      scope: args.scope,
      size: args.size,
      verdicts: collectVerdicts(args),
    });
    return ok(formatSetJson(result, 'tasks', { includeWarnings: true }));
  });
}

export function toolList(store: Store, args: SetQueryArgs): Promise<ToolResult> {
  return guard(async () => {
    // The archived-projects door (ADR 0015) — lists projects, not nodes.
    if (args.status === 'archived') {
      const items = await listProjects(store, undefined, 'archived');
      return ok(
        formatSetJson(
          { items, returned: items.length, startsAt: 0, total: items.length },
          'projects',
        ),
      );
    }
    const result = await listNodes(store, {
      filters: collectFilters(args),
      limit: args.limit,
      priority: args.priority,
      scope: args.scope,
      size: args.size,
      status: args.status,
      tag: args.tag,
      verdicts: collectVerdicts(args),
    });
    return ok(formatSetJson(result, 'tasks', { includeWarnings: true }));
  });
}

export function toolGet(
  store: Store,
  args: { id: string; facets?: (FacetName | 'content')[] },
): Promise<ToolResult> {
  return guard(async () => {
    const requested = args.facets ?? [];
    if (parseIdentity(args.id)?.kind === 'artifact') {
      const content = requested.includes('content');
      return ok(formatArtifactJson(await getArtifact(store, args.id, { content })));
    }
    // `content` is artifact-only; ignore it for nodes/projects.
    const nodeFacets = requested.filter((f): f is FacetName => f !== 'content');
    const facets =
      nodeFacets.length > 0 ? [...new Set<FacetName>([...CHEAP_FACETS, ...nodeFacets])] : undefined;
    return ok(formatNodeJson(await getNode(store, args.id, { facets })));
  });
}

export function toolStatus(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => ok(formatStatusJson(await statusOfNode(store, args.id))));
}

/**
 * `overview` — one project's session-boot orientation surface (MMR-278), the same
 * composite JSON envelope the CLI emits. Reads ONE project: `scope` defaults to the
 * bound board, and the cross-project `all` escape is a category error (a composite
 * is not a cross-project set — `list` serves that).
 */
export function toolOverview(
  store: Store,
  args: { scope?: string },
  boundScope?: string,
): Promise<ToolResult> {
  return guard(async () => {
    if (args.scope === 'all') {
      throw validation(
        'overview reads one project, not a cross-project set',
        'use list for a cross-project set',
      );
    }
    const scope = args.scope ?? boundScope;
    if (scope === undefined) {
      throw validation('overview needs a project', 'pass scope or bind a project');
    }
    return ok(formatOverviewJson(await overviewOf(store, scope)));
  });
}

/** The `artifacts` tool args (MMR-322) — the CLI feed's flags under their
 * camelCase MCP spellings; every filter AND-composes. */
export type ArtifactQueryToolArgs = {
  scope?: string;
  tag?: string;
  since?: string;
  before?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

/**
 * `artifacts` — the cross-project artifact feed (MMR-322), newest-first, metadata
 * only (a frozen body is `get KEY-aN` with the `content` facet). Unlike
 * `overview` this IS a cross-project read: `scope` defaults to the bound board
 * and the literal `all` widens to the portfolio, exactly as on `list`/`next`.
 */
export function toolArtifacts(store: Store, args: ArtifactQueryToolArgs): Promise<ToolResult> {
  return guard(async () => {
    // The date bounds are checked, not merely normalized: the filter is a lexical
    // compare downstream, so `since: "yesterday"` would not error — it would sort
    // against the ISO timestamps and quietly return the wrong window. Same
    // predicate the CLI enforces (`isFilterDate`), different refusal: a
    // `validation` envelope here, usage/exit 2 there.
    for (const [name, value] of [
      ['since', args.since],
      ['before', args.before],
    ] as const) {
      if (value !== undefined && !isFilterDate(value)) {
        throw validation(
          `invalid date: ${value}`,
          `${name} takes YYYY-MM-DD or a full ISO timestamp`,
        );
      }
    }
    return ok(
      formatArtifactSetJson(
        await listArtifacts(store, {
          before: args.before,
          limit: args.limit,
          offset: args.offset,
          q: args.q,
          scope: args.scope,
          since: args.since,
          tag: args.tag,
        }),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Uniform mutation tools (ADR 0025 Decision 3)
// ---------------------------------------------------------------------------

/**
 * The one generic handler for the twelve uniform verbs — the twelve per-verb
 * `toolStart`/`toolArchive`/… handlers collapsed to a single registry-driven
 * function (ADR 0025). Resolves the subject by its id-kind (a task stem vs a
 * project KEY), applies the reason per the verb's policy, runs the bound
 * mutation, and echoes the matching record shape. `mcp/server.ts` loop-registers
 * one MCP tool per registry entry over this handler, so adding a uniform verb
 * needs no transport edit.
 *
 * A verb declaring extra data-plane fields (ADR 0026 — only `start`'s resume
 * handles) reads them by their camelCase update-arg names through the shared
 * {@link applyUpdateFields} loop, so acceptance and application can't drift apart.
 */
export type UniformToolArgs = {
  id?: string;
  key?: string;
  reason?: string;
} & Record<string, unknown>;

export function toolUniform(
  store: Store,
  verb: UniformVerb,
  args: UniformToolArgs,
): Promise<ToolResult> {
  return guard(async () => {
    const op = OPS[verb];
    const reason = op.reason === 'optional' ? args.reason : undefined;
    if (op.subject === 'project') {
      const project = await op.run(store, await projectId(store, args.key ?? ''), reason);
      // The project subject guarantees a Project row from `run`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return echoProject(store, project as Parameters<typeof echoProject>[1]);
    }
    const fields: UpdateFields = {};
    applyUpdateFields(
      fields,
      (field) => {
        const value = args[field.update];
        // Zod-validated against the kind fragment, so a present value is a string.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return value === undefined ? undefined : parseWireField(field.kind, value as string);
      },
      specUpdateFields(op.fields ?? []),
    );
    const node = await op.run(store, await nodeId(store, args.id ?? '', 'task'), reason, fields);
    // The task subject guarantees a Node row from `run`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return echoNode(store, node as Parameters<typeof echoNode>[1]);
  });
}

// ---------------------------------------------------------------------------
// Dependency mutation tools
// ---------------------------------------------------------------------------

export function toolDepend(store: Store, args: { id: string; on: string[] }): Promise<ToolResult> {
  return guard(async () => {
    const set = deriveSet(await store.loadWorkingSet());
    const id = nodeIdIn(set, args.id);
    const onIds = args.on.map((t) => nodeIdIn(set, t));
    const node = await depend(store, id, onIds);
    return echoNode(store, node);
  });
}

export function toolUndepend(
  store: Store,
  args: { id: string; on: string[] },
): Promise<ToolResult> {
  return guard(async () => {
    const set = deriveSet(await store.loadWorkingSet());
    const id = nodeIdIn(set, args.id);
    const onIds = args.on.map((t) => nodeIdIn(set, t));
    const node = await undepend(store, id, onIds);
    return echoNode(store, node);
  });
}

// ---------------------------------------------------------------------------
// Structure mutation tools
// ---------------------------------------------------------------------------

export function toolMove(store: Store, args: { id: string; to: string }): Promise<ToolResult> {
  return guard(async () => {
    const set = deriveSet(await store.loadWorkingSet());
    const node = await moveNode(store, nodeIdIn(set, args.id), nodeIdIn(set, args.to));
    return echoNode(store, node);
  });
}

export function toolReorder(
  store: Store,
  args: { id: string; position: 'top' | 'bottom' | 'before' | 'after'; ref?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const position: RankPosition = args.position;
    let refId: string | null = null;
    if (position === 'before' || position === 'after') {
      if (args.ref === undefined) {
        throw validation('reorder before/after requires ref');
      }
      refId = await nodeId(store, args.ref);
    }
    const node = await reorder(store, id, position, refId);
    return echoNode(store, node);
  });
}

// ---------------------------------------------------------------------------
// Data mutation tools
// ---------------------------------------------------------------------------

/**
 * Compile guard (MMR-320): the two write tools' arg types are hand-written while
 * their advertised zod shapes DERIVE from the field spec (`fieldInputShape`). A
 * new spec field therefore lands on the wire — accepted and applied — while the
 * exported type silently lags, forcing every direct TS caller to cast past an
 * excess-property error the runtime would have accepted. Naming the two types and
 * excluding them from {@link SpecUpdateKey} makes that lag a type error instead.
 */
type AssertNever<T extends never> = T;
type _UpdateArgsCoverSpec = AssertNever<Exclude<SpecUpdateKey, keyof UpdateToolArgs>>;
type _CreateArgsCoverSpec = AssertNever<Exclude<SpecUpdateKey, keyof CreateToolArgs>>;

export type UpdateToolArgs = {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  /** The owned `## Next` direction narrative (MMR-321) — project/container-only.
   * Body prose, not a data-plane spec field, so it is hand-listed like
   * `description` and never reaches the {@link SpecUpdateKey} guard above. */
  next?: string;
  summary?: string;
  priority?: string;
  size?: string;
  target?: string;
  externalRef?: string;
  upstream?: string;
  /** The resume handles (MMR-320) — task-only. */
  host?: string;
  harness?: string;
  session?: string;
  branch?: string;
  kind?: string;
  openEnded?: boolean;
};

export function toolUpdate(store: Store, args: UpdateToolArgs): Promise<ToolResult> {
  return guard(async () => {
    if (parseIdentity(args.id)?.kind === 'artifact') {
      return updateArtifactTool(store, args);
    }
    if (parseIdentity(args.id)?.kind === 'project') {
      return updateProjectTool(store, args);
    }
    if (parseIdentity(args.id)?.kind === 'seed') {
      return updateSeedTool(store, args);
    }
    const id = await nodeId(store, args.id);
    const fields: UpdateFields = {};
    // title/description are the bespoke identity/prose plane; the scalar data
    // fields derive from the spec (ADR 0025).
    if (args.title !== undefined) {
      fields.title = args.title;
    }
    if (args.description !== undefined) {
      fields.description = args.description;
    }
    // The `## Next` narrative (MMR-321) — body prose alongside description, so
    // it is read here rather than through the data-plane spec.
    if (args.next !== undefined) {
      fields.next = args.next;
    }
    // Zod-validated: the string-family kinds arrive as strings, openEnded (`bool`)
    // as a boolean read natively.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const raw = args as Record<string, string | boolean | undefined>;
    applyUpdateFields(fields, (field) => {
      const value = raw[field.update];
      if (value === undefined || field.kind === 'bool') {
        return value;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return parseWireField(field.kind, value as string);
    });
    const node = await updateNode(store, id, fields);
    return echoNode(store, node);
  });
}

/** `update KEY` — patch a project's `name`, `description`, and/or the owned
 * `## Next` narrative (MMR-88, MMR-321). */
async function updateProjectTool(
  store: Store,
  args: {
    id: string;
    name?: string;
    description?: string;
    next?: string;
    summary?: string;
    title?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    openEnded?: boolean;
    upstream?: string;
    host?: string;
    harness?: string;
    session?: string;
    branch?: string;
  },
): Promise<ToolResult> {
  const nodeOnly = inapplicableUpdateFields('project').filter((k) => args[k] !== undefined);
  if (nodeOnly.length > 0) {
    throw validation(
      `${nodeOnly.join(', ')} appl${nodeOnly.length === 1 ? 'ies' : 'y'} only to nodes — use name to rename a project`,
    );
  }
  const key = args.id;
  const pid = await projectId(store, key);
  const fields: UpdateProjectFields = {};
  if (args.name !== undefined) {
    fields.name = args.name;
  }
  if (args.description !== undefined) {
    fields.description = args.description;
  }
  if (args.next !== undefined) {
    fields.next = args.next;
  }
  await updateProject(store, pid, fields);
  // Echo the updated project through the same projection as getNode/get KEY
  const view = await projectViewByKey(store, key, WRITE_ECHO_FACET_SET);
  if (view === undefined) {
    throw projectNotFound(key);
  }
  return ok(formatNodeJson(view));
}

/** `update` on a `KEY-aN` id — title and summary are an artifact's mutable
 * fields (MMR-40, MMR-319). */
async function updateArtifactTool(
  store: Store,
  args: {
    id: string;
    title?: string;
    description?: string;
    next?: string;
    summary?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    openEnded?: boolean;
    upstream?: string;
    host?: string;
    harness?: string;
    session?: string;
    branch?: string;
  },
): Promise<ToolResult> {
  const nodeOnly = inapplicableUpdateFields('artifact').filter((k) => args[k] !== undefined);
  if (nodeOnly.length > 0) {
    throw validation(
      `${nodeOnly.join(', ')} appl${nodeOnly.length === 1 ? 'ies' : 'y'} only to nodes — title and summary are an artifact's mutable fields`,
    );
  }
  const identity = parseIdentity(args.id);
  if (identity?.kind !== 'artifact') {
    throw notFound(`${args.id} doesn't exist`);
  }
  const fields: ArtifactUpdateFields = {};
  if (args.title !== undefined) {
    fields.title = args.title;
  }
  if (args.summary !== undefined) {
    fields.summary = args.summary;
  }
  if (Object.keys(fields).length > 0) {
    await updateArtifact(store, { key: identity.key, seq: identity.seq }, fields);
  }
  return ok(formatArtifactJson(await getArtifact(store, args.id)));
}

export function toolAnnotate(
  store: Store,
  args: { id: string; content: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id);
    const node = await annotate(store, id, args.content);
    return echoNode(store, node);
  });
}

// ---------------------------------------------------------------------------
// Tag tools (MMR-31)
// ---------------------------------------------------------------------------

export function toolTag(
  store: Store,
  args: { ids: string[]; tags: string[] },
): Promise<ToolResult> {
  return guard(async () => {
    if (args.ids.length === 0) {
      throw validation('tag requires at least one id');
    }
    if (args.tags.length === 0) {
      throw validation('tag requires at least one tag');
    }
    const tagSet = deriveSet(await store.loadWorkingSet());
    const targets = args.ids.map((t) => resolveEntityTokenInSet(tagSet, t));
    await tagEntities(store, targets, args.tags);
    return ok(JSON.stringify({ tagged: { ids: args.ids, tags: args.tags } }));
  });
}

export function toolUntag(
  store: Store,
  args: { ids: string[]; tags: string[] },
): Promise<ToolResult> {
  return guard(async () => {
    if (args.ids.length === 0) {
      throw validation('untag requires at least one id');
    }
    if (args.tags.length === 0) {
      throw validation('untag requires at least one tag');
    }
    const untagSet = deriveSet(await store.loadWorkingSet());
    const targets = args.ids.map((t) => resolveEntityTokenInSet(untagSet, t));
    await untagEntities(store, targets, args.tags);
    return ok(JSON.stringify({ untagged: { ids: args.ids, tags: args.tags } }));
  });
}

// ---------------------------------------------------------------------------
// Create tool
// ---------------------------------------------------------------------------

export type CreateToolArgs = {
  type: 'project' | 'initiative' | 'phase' | 'task';
  key?: string;
  name?: string;
  parent?: string;
  title?: string;
  description?: string;
  summary?: string;
  target?: string;
  priority?: string;
  size?: string;
  externalRef?: string;
  upstream?: string;
  /** The resume handles (MMR-320) — task-only, normally set by `start`. */
  host?: string;
  harness?: string;
  session?: string;
  branch?: string;
  openEnded?: boolean;
  tags?: string[];
};

export function toolCreate(store: Store, args: CreateToolArgs): Promise<ToolResult> {
  return guard(async () => {
    switch (args.type) {
      case 'project': {
        if (args.key === undefined) {
          throw validation('create project requires key');
        }
        if (args.name === undefined) {
          throw validation('create project requires name');
        }
        const project = await createNode(store, {
          description: args.description,
          key: args.key,
          name: args.name,
          openEnded: args.openEnded,
          tags: args.tags,
          type: 'project',
        });
        return ok(JSON.stringify({ project: { key: project.key, name: project.name } }));
      }
      case 'initiative': {
        if (args.title === undefined) {
          throw validation('create initiative requires title');
        }
        if (args.parent === undefined) {
          throw validation('create initiative requires parent');
        }
        const node = await createNode(store, {
          description: args.description,
          openEnded: args.openEnded,
          parent: args.parent,
          summary: args.summary,
          tags: args.tags,
          title: args.title,
          type: 'initiative',
        });
        return echoNode(store, node);
      }
      case 'phase': {
        if (args.title === undefined) {
          throw validation('create phase requires title');
        }
        if (args.parent === undefined) {
          throw validation('create phase requires parent');
        }
        const node = await createNode(store, {
          description: args.description,
          openEnded: args.openEnded,
          parent: args.parent,
          summary: args.summary,
          tags: args.tags,
          target: args.target,
          title: args.title,
          type: 'phase',
        });
        return echoNode(store, node);
      }
      case 'task': {
        if (args.title === undefined) {
          throw validation('create task requires title');
        }
        if (args.parent === undefined) {
          throw validation('create task requires parent');
        }
        const node = await createNode(store, {
          description: args.description,
          externalRef: args.externalRef,
          // The resume handles (MMR-320) — accepted at create like every other
          // generic-`update` spec field; `start` is where they usually land.
          handles: {
            branch: args.branch,
            harness: args.harness,
            host: args.host,
            session: args.session,
          },
          openEnded: args.openEnded,
          parent: args.parent,
          priority: args.priority,
          size: args.size,
          summary: args.summary,
          tags: args.tags,
          title: args.title,
          type: 'task',
          upstream: args.upstream,
        });
        return echoNode(store, node);
      }
      default: {
        throw validation(`create: unknown type ${(args as { type: string }).type}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Attach tool
// ---------------------------------------------------------------------------

export function toolAttach(
  store: Store,
  args: {
    node?: string;
    project?: string;
    title: string;
    content: string;
    summary?: string;
    links?: string[];
    tags?: string[];
  },
): Promise<ToolResult> {
  return guard(async () => {
    // Gather all node ref tokens: primary node (if any) + links
    const linkTokens: string[] = [];
    if (args.node !== undefined) {
      linkTokens.push(args.node);
    }
    if (args.links !== undefined) {
      for (const t of args.links) {
        const trimmed = t.trim();
        if (trimmed.length > 0) {
          linkTokens.push(trimmed);
        }
      }
    }

    // Dedup, the one-project invariant, and project agreement all live in core
    // (MMR-305); the native required-arg gap stays here.
    if (linkTokens.length === 0 && args.project === undefined) {
      throw validation('attach requires a link (KEY-seq) or a project key');
    }
    const { linkNodeIds, projectId: pid } = await resolveAttachTargets(
      store,
      linkTokens,
      args.project,
    );

    const { renderedId } = await attachArtifact(store, {
      content: args.content,
      linkNodeIds,
      projectId: pid,
      summary: args.summary,
      tags: args.tags,
      title: args.title,
    });
    return ok(JSON.stringify({ artifact: { id: renderedId } }));
  });
}

// ---------------------------------------------------------------------------
// Seed tools (MMR-245)
// ---------------------------------------------------------------------------

/** Narrow a raw `kind` arg to the closed seed-kind enum, or throw. Shares the core
 * narrowing helper with the CLI/HTTP boundaries (M4). */
function requireSeedKind(kind: string): SeedKind {
  const narrowed = asSeedKind(kind);
  if (narrowed === null) {
    throw validation(`invalid kind: ${kind}`, `kinds: ${SEED_KIND_VALUES.join(', ')}`);
  }
  return narrowed;
}

export function toolSeed(
  store: Store,
  args: { title: string; kind: string; project?: string; description?: string },
  boundScope?: string,
): Promise<ToolResult> {
  return guard(async () => {
    const target = args.project ?? boundScope;
    if (target === undefined) {
      throw validation('seed requires a target project', 'pass project or bind a board');
    }
    // requester = the bound board only when filing into a DIFFERENT board (else self-filed).
    const requester = boundScope !== undefined && boundScope !== target ? boundScope : null;
    const seed = await fileSeed(store, {
      description: args.description,
      kind: requireSeedKind(args.kind),
      project: target,
      requester,
      title: args.title,
    });
    return ok(formatSeedJson(seed));
  });
}

export function toolSeeds(
  store: Store,
  args: {
    project?: string;
    requester?: string;
    status?: SeedStatusSelector;
    sort?: 'asc' | 'desc';
  },
  boundScope?: string,
): Promise<ToolResult> {
  return guard(async () => {
    // `project: "all"` (or the unbound default) reads every active board's queue —
    // `'all'` is honored at the intent seam (`listSeeds`), so all three transports
    // converge on one mapping instead of each special-casing it (B5b).
    const project = args.project ?? boundScope;
    const seeds = await listSeeds(store, {
      project,
      requester: args.requester,
      sort: args.sort,
      status: args.status,
    });
    return ok(formatSeedsJson(seeds));
  });
}

export function toolGetSeed(
  store: Store,
  args: { id: string; content?: boolean },
): Promise<ToolResult> {
  return guard(async () =>
    ok(formatSeedJson(await getSeed(store, args.id, { content: args.content ?? true }))),
  );
}

export function toolPromote(
  store: Store,
  args: {
    id: string;
    parent?: string;
    link?: string;
    title?: string;
    description?: string;
    priority?: string;
    size?: string;
    tags?: string[];
  },
): Promise<ToolResult> {
  return guard(async () => {
    const { created, seed } = await promoteSeed(store, args.id, {
      description: args.description,
      link: args.link,
      parent: args.parent,
      priority: parsePriorityValue(args.priority),
      size: parseSizeValue(args.size),
      tags: args.tags,
      title: args.title,
    });
    // Surface the created task id as a sibling field so an agent can act on the
    // spawned work without a second lookup (B7).
    return ok(formatPromoteJson(seed, created));
  });
}

export function toolReject(
  store: Store,
  args: { id: string; reason: string },
): Promise<ToolResult> {
  return guard(async () =>
    ok(formatSeedJson(await transitionSeed(store, args.id, 'rejected', args.reason))),
  );
}

export function toolResolve(
  store: Store,
  args: { id: string; reason: string },
): Promise<ToolResult> {
  return guard(async () =>
    ok(formatSeedJson(await transitionSeed(store, args.id, 'resolved', args.reason))),
  );
}

/** `triage [board]` — the reconciliation pass (MMR-246), 1:1 with the CLI. Writes
 * the check-(c) annotations by default; `dryRun` previews. `board` defaults to the
 * bound board. Returns the three-check report; NEVER transitions anything. */
export function toolTriage(
  store: Store,
  args: { board?: string; dryRun?: boolean },
  boundScope?: string,
): Promise<ToolResult> {
  return guard(async () => {
    const board = resolveBoard(args.board, boundScope, validation);
    return ok(formatTriageJson(await triage(store, { board, dryRun: args.dryRun ?? false })));
  });
}

/** `update KEY-sN` — patch a live seed's title/kind/description (MMR-245). */
async function updateSeedTool(
  store: Store,
  args: {
    id: string;
    title?: string;
    description?: string;
    next?: string;
    kind?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    upstream?: string;
    summary?: string;
    openEnded?: boolean;
    host?: string;
    harness?: string;
    session?: string;
    branch?: string;
  },
): Promise<ToolResult> {
  const seedOnly = inapplicableUpdateFields('seed').filter((k) => args[k] !== undefined);
  if (seedOnly.length > 0) {
    throw validation(
      `${seedOnly.join(', ')} do not apply to a seed — patch title, kind, or description`,
    );
  }
  const fields: UpdateSeedFields = {};
  if (args.title !== undefined) {
    fields.title = args.title;
  }
  if (args.description !== undefined) {
    fields.description = args.description;
  }
  if (args.kind !== undefined) {
    fields.kind = requireSeedKind(args.kind);
  }
  return ok(formatSeedJson(await updateSeed(store, args.id, fields)));
}
