import { CHEAP_FACETS, PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type {
  FacetName,
  FieldFilter,
  Priority,
  QueryOp,
  Size,
  StatusSelector,
  Verdict,
  VerdictSelector,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import {
  MimirError,
  abandonTask,
  annotate,
  archiveProject,
  attachArtifact,
  blockTask,
  deriveSet,
  findNodeInSet,
  nodeViewOf,
  projectViewByKey,
  projectViewOf,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  resolveNodeTokenInSet,
  resolveProjectKeyInSet,
  formatArtifactJson,
  formatNodeJson,
  formatSetJson,
  formatStatusJson,
  getArtifact,
  getNode,
  listNodes,
  listProjects,
  moveNode,
  nextTasks,
  notFound,
  projectNotFound,
  parkTask,
  reorder,
  resolveEntityTokenInSet,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
  statusOfNode,
  tagEntities,
  unarchiveProject,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  parseFilterToken,
  parseId,
  parseIdentity,
  updateProject,
  validation,
} from '../core';
import type {
  DerivationSet,
  RankPosition,
  Store,
  UpdateFields,
  UpdateProjectFields,
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

const fail = (code: string, message: string, hint?: string): ToolResult => ({
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
function nodeIdIn(set: DerivationSet, id: string, expected = 'node'): number {
  return resolveNodeTokenInSet(set, id, expected);
}

/** Resolve a node token over its own fresh working-set snapshot (MMR-160, no raw
 * db). Handlers resolving multiple tokens derive one set + `nodeIdIn`. */
async function nodeId(store: Store, id: string, expected = 'node'): Promise<number> {
  return nodeIdIn(deriveSet(await store.loadWorkingSet()), id, expected);
}

/**
 * Resolve a bare project KEY to its surrogate integer id over the working set.
 * Throws not_found if no project with that key exists.
 */
async function projectId(store: Store, key: string): Promise<number> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/**
 * Echo a returned Node row as bare JSON (the mutation echo contract).
 * Accepts the Node row returned directly by mutation verbs — no reload needed.
 * Typed via `Parameters` to avoid importing the `Node` row type directly.
 * Requests the `description` facet (facet-gated since MMR-162) so a mutation that
 * set it echoes the value back rather than dropping the field it just wrote.
 */
async function echoNode(store: Store, node: Parameters<typeof nodeViewOf>[1]): Promise<ToolResult> {
  return ok(formatNodeJson(await nodeViewOf(store, node, new Set<FacetName>(['description']))));
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

const OP_ARGS: [QueryOp, keyof SetQueryArgs][] = [
  ['eq', 'eq'],
  ['not-eq', 'notEq'],
  ['in', 'in'],
  ['not-in', 'notIn'],
  ['has', 'has'],
  ['missing', 'missing'],
  ['before', 'before'],
  ['on', 'on'],
  ['after', 'after'],
  ['not-before', 'notBefore'],
  ['not-after', 'notAfter'],
];

function collectFilters(args: SetQueryArgs): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const [op, key] of OP_ARGS) {
    const tokens = args[key];
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

// ---------------------------------------------------------------------------
// Lifecycle mutation tools
// ---------------------------------------------------------------------------

export function toolStart(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await startTask(store, id);
    return echoNode(store, node);
  });
}

export function toolSubmit(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await submitTask(store, id);
    return echoNode(store, node);
  });
}

export function toolReturn(
  store: Store,
  args: { id: string; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await returnTask(store, id, args.reason);
    return echoNode(store, node);
  });
}

export function toolReopen(
  store: Store,
  args: { id: string; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await reopenTask(store, id, args.reason);
    return echoNode(store, node);
  });
}

/** Archive a project — freeze + hide it and its subtree (ADR 0015). Echoes the project. */
export function toolArchive(
  store: Store,
  args: { key: string; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const project = await archiveProject(store, await projectId(store, args.key), args.reason);
    return ok(formatNodeJson(await projectViewOf(store, project)));
  });
}

/** Unarchive a project (ADR 0015). Echoes the project. */
export function toolUnarchive(store: Store, args: { key: string }): Promise<ToolResult> {
  return guard(async () => {
    const project = await unarchiveProject(store, await projectId(store, args.key));
    return ok(formatNodeJson(await projectViewOf(store, project)));
  });
}

export function toolDone(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await completeTask(store, id);
    return echoNode(store, node);
  });
}

export function toolAbandon(
  store: Store,
  args: { id: string; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await abandonTask(store, id, args.reason);
    return echoNode(store, node);
  });
}

// ---------------------------------------------------------------------------
// Hold mutation tools
// ---------------------------------------------------------------------------

export function toolPark(store: Store, args: { id: string; reason?: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await parkTask(store, id, args.reason);
    return echoNode(store, node);
  });
}

export function toolUnpark(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await unparkTask(store, id);
    return echoNode(store, node);
  });
}

export function toolBlock(
  store: Store,
  args: { id: string; reason?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await blockTask(store, id, args.reason);
    return echoNode(store, node);
  });
}

export function toolUnblock(store: Store, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(store, args.id, 'task');
    const node = await unblockTask(store, id);
    return echoNode(store, node);
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
    let refId: number | null = null;
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

export function toolUpdate(
  store: Store,
  args: {
    id: string;
    title?: string;
    name?: string;
    description?: string;
    summary?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    openEnded?: boolean;
  },
): Promise<ToolResult> {
  return guard(async () => {
    if (parseIdentity(args.id)?.kind === 'artifact') {
      return updateArtifactTool(store, args);
    }
    if (parseIdentity(args.id)?.kind === 'project') {
      return updateProjectTool(store, args);
    }
    const id = await nodeId(store, args.id);
    const fields: UpdateFields = {};
    if (args.title !== undefined) {
      fields.title = args.title;
    }
    if (args.description !== undefined) {
      fields.description = args.description;
    }
    if (args.summary !== undefined) {
      fields.summary = args.summary;
    }
    if (args.priority !== undefined) {
      if (!isMember(args.priority, PRIORITY_VALUES)) {
        throw validation(
          `invalid priority: ${args.priority}`,
          `priorities: ${PRIORITY_VALUES.join(', ')}`,
        );
      }
      fields.priority = args.priority;
    }
    if (args.size !== undefined) {
      if (!isMember(args.size, SIZE_VALUES)) {
        throw validation(`invalid size: ${args.size}`, `sizes: ${SIZE_VALUES.join(', ')}`);
      }
      fields.size = args.size;
    }
    if (args.target !== undefined) {
      fields.target = args.target;
    }
    if (args.externalRef !== undefined) {
      fields.externalRef = args.externalRef;
    }
    if (args.openEnded !== undefined) {
      fields.openEnded = args.openEnded;
    }
    const node = await updateNode(store, id, fields);
    return echoNode(store, node);
  });
}

/** `update KEY` — patch a project's `name` and/or `description` (MMR-88). */
async function updateProjectTool(
  store: Store,
  args: {
    id: string;
    name?: string;
    description?: string;
    summary?: string;
    title?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    openEnded?: boolean;
  },
): Promise<ToolResult> {
  const nodeOnly = (
    ['title', 'priority', 'size', 'target', 'externalRef', 'summary', 'openEnded'] as const
  ).filter((k) => args[k] !== undefined);
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
  await updateProject(store, pid, fields);
  // Echo the updated project through the same projection as getNode/get KEY
  const view = await projectViewByKey(store, key);
  if (view === undefined) {
    throw projectNotFound(key);
  }
  return ok(formatNodeJson(view));
}

/** `update` on a `KEY-aN` id — title is an artifact's one mutable field (MMR-40). */
async function updateArtifactTool(
  store: Store,
  args: {
    id: string;
    title?: string;
    description?: string;
    summary?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
    openEnded?: boolean;
  },
): Promise<ToolResult> {
  const nodeOnly = (
    ['description', 'priority', 'size', 'target', 'externalRef', 'summary', 'openEnded'] as const
  ).filter((k) => args[k] !== undefined);
  if (nodeOnly.length > 0) {
    throw validation(
      `${nodeOnly.join(', ')} appl${nodeOnly.length === 1 ? 'ies' : 'y'} only to nodes — title is an artifact's one mutable field`,
    );
  }
  const identity = parseIdentity(args.id);
  if (identity?.kind !== 'artifact') {
    throw notFound(`no artifact with id ${args.id}`);
  }
  if (args.title !== undefined) {
    await updateArtifact(store, { key: identity.key, seq: identity.seq }, { title: args.title });
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
  args: { ids: string[]; tags: string[]; note?: string },
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
    await tagEntities(store, targets, args.tags, args.note);
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

export function toolCreate(
  store: Store,
  args: {
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
    openEnded?: boolean;
    tags?: string[];
  },
): Promise<ToolResult> {
  return guard(async () => {
    // open_ended is container-only — reject it on task/project (symmetry with
    // `update`; MMR-204). Only initiative/phase consume it below.
    if (args.openEnded !== undefined && (args.type === 'task' || args.type === 'project')) {
      throw validation('open_ended applies only to phases and initiatives');
    }
    switch (args.type) {
      case 'project': {
        if (args.key === undefined) {
          throw validation('create project requires key');
        }
        if (args.name === undefined) {
          throw validation('create project requires name');
        }
        const project = await createProject(store, {
          description: args.description,
          key: args.key,
          name: args.name,
          tags: args.tags,
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
        // Initiative parent must be a bare project KEY (not a node ref)
        if (parseId(args.parent) !== null) {
          throw validation("an initiative's parent must be a project (KEY)");
        }
        const pid = await projectId(store, args.parent);
        const node = await createInitiative(store, {
          description: args.description,
          openEnded: args.openEnded,
          projectId: pid,
          summary: args.summary,
          tags: args.tags,
          title: args.title,
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
        // Phase parent must be a node ref (initiative)
        if (parseId(args.parent) === null) {
          throw validation("a phase's parent must be an initiative (KEY-seq)");
        }
        const parentNodeId = await nodeId(store, args.parent);
        const node = await createPhase(store, {
          description: args.description,
          openEnded: args.openEnded,
          parentId: parentNodeId,
          summary: args.summary,
          tags: args.tags,
          target: args.target,
          title: args.title,
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
        // Task parent must be a node ref (phase or initiative)
        if (parseId(args.parent) === null) {
          throw validation("a task's parent must be a phase or initiative (KEY-seq)");
        }
        const parentNodeId = await nodeId(store, args.parent);
        if (args.priority !== undefined && !isMember(args.priority, PRIORITY_VALUES)) {
          throw validation(
            `invalid priority: ${args.priority}`,
            `priorities: ${PRIORITY_VALUES.join(', ')}`,
          );
        }
        if (args.size !== undefined && !isMember(args.size, SIZE_VALUES)) {
          throw validation(`invalid size: ${args.size}`, `sizes: ${SIZE_VALUES.join(', ')}`);
        }
        const node = await createTask(store, {
          description: args.description,
          externalRef: args.externalRef,
          parentId: parentNodeId,
          priority: args.priority,
          size: args.size,
          summary: args.summary,
          tags: args.tags,
          title: args.title,
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

    let pid: number;
    const linkNodeIds: number[] = [];

    if (linkTokens.length > 0) {
      // Resolve all node refs; require they all belong to one project
      const linkSet = deriveSet(await store.loadWorkingSet());
      const nodes = linkTokens.map((t) => {
        const n = findNodeInSet(linkSet, t);
        if (n === undefined) {
          throw notFound(`${t} doesn't exist`);
        }
        return n;
      });
      const projects = new Set(nodes.map((n) => n.project_id));
      if (projects.size > 1) {
        throw validation('all the links must be in one project');
      }
      const [resolvedProjectId] = projects;
      if (resolvedProjectId === undefined) {
        throw validation('internal: links resolved but project is missing');
      }
      pid = resolvedProjectId;
      linkNodeIds.push(...nodes.map((n) => n.id));
      // If --project is also provided, it must agree
      if (args.project !== undefined) {
        const explicitId = await projectId(store, args.project);
        if (explicitId !== pid) {
          throw validation("project disagrees with the links' project");
        }
      }
    } else {
      // No links — project is required
      if (args.project === undefined) {
        throw validation('attach requires a link (KEY-seq) or a project key');
      }
      pid = await projectId(store, args.project);
    }

    const { renderedId } = await attachArtifact(store, {
      content: args.content,
      linkNodeIds,
      projectId: pid,
      tags: args.tags,
      title: args.title,
    });
    return ok(JSON.stringify({ artifact: { id: renderedId } }));
  });
}
