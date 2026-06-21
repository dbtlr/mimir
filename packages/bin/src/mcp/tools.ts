import {
  CHEAP_FACETS,
  type FacetName,
  type FieldFilter,
  type Priority,
  type QueryOp,
  type Size,
  type StatusSelector,
  type Verdict,
  type VerdictSelector,
} from "@mimir/contract";
import {
  MimirError,
  type UpdateFields,
  type UpdateProjectFields,
  abandonTask,
  annotate,
  attachArtifact,
  blockTask,
  buildNodeView,
  buildProjectView,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  findArtifactByRef,
  findNodeByRef,
  resolveNodeToken,
  formatArtifactJson,
  formatNodeJson,
  formatSetJson,
  formatStatusJson,
  getArtifact,
  getNode,
  listNodes,
  moveNode,
  nextTasks,
  notFound,
  projectNotFound,
  parkTask,
  reorder,
  resolveEntityToken,
  startTask,
  statusOfNode,
  tagEntities,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
  validation,
} from "../core";
import type { Db } from "../core";
import { parseFilterToken, parseId, parseIdentity } from "../core";
import type { RankPosition } from "../core";

/**
 * The MCP tool handlers — the agent envelope over the shared intent layer.
 * Token-conscious: results are the structured `json` rendering (the same wire
 * contract the CLI emits). Kept as plain functions so they can be tested
 * against a real DB without standing up a transport.
 */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // The SDK's CallToolResult carries an open index signature; matching it keeps
  // these handlers assignable as tool callbacks.
  [key: string]: unknown;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

const fail = (code: string, message: string, hint?: string): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        hint === undefined ? { error: { code, message } } : { error: { code, message, hint } },
      ),
    },
  ],
  isError: true,
});

/** Map a thrown {@link MimirError} to a structured `isError` result; rethrow anything else. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MimirError) return fail(error.code, error.message, error.hint);
    throw error;
  }
}

/** Resolve a node token to its surrogate id — the MCP binding of the core guard. */
async function nodeId(db: Db, id: string, expected = "node"): Promise<number> {
  return resolveNodeToken(db, id, expected);
}

/**
 * Resolve a bare project KEY to its surrogate integer id.
 * Throws not_found if no project with that key exists.
 */
async function projectId(db: Db, key: string): Promise<number> {
  const row = await db.selectFrom("project").select("id").where("key", "=", key).executeTakeFirst();
  if (row === undefined) throw projectNotFound(key);
  return row.id;
}

/**
 * Echo a returned Node row as bare JSON (the mutation echo contract).
 * Accepts the Node row returned directly by mutation verbs — no reload needed.
 * Typed via `Parameters` to avoid importing `Node` from db directly.
 */
async function echoNode(db: Db, node: Parameters<typeof buildNodeView>[1]): Promise<ToolResult> {
  return ok(formatNodeJson(await buildNodeView(db, node)));
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/** The set-selection args shared by `next` and `list` (MMR-33) — named arrays per operator. */
export interface SetQueryArgs {
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
}

const OP_ARGS: [QueryOp, keyof SetQueryArgs][] = [
  ["eq", "eq"],
  ["not-eq", "notEq"],
  ["in", "in"],
  ["not-in", "notIn"],
  ["has", "has"],
  ["missing", "missing"],
  ["before", "before"],
  ["on", "on"],
  ["after", "after"],
  ["not-before", "notBefore"],
  ["not-after", "notAfter"],
];

function collectFilters(args: SetQueryArgs): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const [op, key] of OP_ARGS) {
    const tokens = args[key];
    if (!Array.isArray(tokens)) continue;
    for (const token of tokens) {
      filters.push(parseFilterToken(op, token));
    }
  }
  return filters;
}

function collectVerdicts(args: SetQueryArgs): VerdictSelector[] {
  return [
    ...(args.is ?? []).map((verdict) => ({ verdict, negate: false })),
    ...(args.notIs ?? []).map((verdict) => ({ verdict, negate: true })),
  ];
}

export function toolNext(db: Db, args: SetQueryArgs): Promise<ToolResult> {
  return guard(async () => {
    const result = await nextTasks(db, {
      scope: args.scope,
      priority: args.priority,
      size: args.size,
      verdicts: collectVerdicts(args),
      filters: collectFilters(args),
      limit: args.limit,
    });
    return ok(formatSetJson(result, "tasks", { includeWarnings: true }));
  });
}

export function toolList(db: Db, args: SetQueryArgs): Promise<ToolResult> {
  return guard(async () => {
    const result = await listNodes(db, {
      scope: args.scope,
      status: args.status,
      verdicts: collectVerdicts(args),
      filters: collectFilters(args),
      priority: args.priority,
      size: args.size,
      tag: args.tag,
      limit: args.limit,
    });
    return ok(formatSetJson(result, "tasks", { includeWarnings: true }));
  });
}

export function toolGet(
  db: Db,
  args: { id: string; facets?: (FacetName | "content")[] },
): Promise<ToolResult> {
  return guard(async () => {
    const requested = args.facets ?? [];
    if (parseIdentity(args.id)?.kind === "artifact") {
      const content = requested.includes("content");
      return ok(formatArtifactJson(await getArtifact(db, args.id, { content })));
    }
    // `content` is artifact-only; ignore it for nodes/projects.
    const nodeFacets = requested.filter((f): f is FacetName => f !== "content");
    const facets =
      nodeFacets.length > 0 ? [...new Set<FacetName>([...CHEAP_FACETS, ...nodeFacets])] : undefined;
    return ok(formatNodeJson(await getNode(db, args.id, { facets })));
  });
}

export function toolStatus(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => ok(formatStatusJson(await statusOfNode(db, args.id))));
}

// ---------------------------------------------------------------------------
// Lifecycle mutation tools
// ---------------------------------------------------------------------------

export function toolStart(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await startTask(db, id);
    return echoNode(db, node);
  });
}

export function toolDone(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await completeTask(db, id);
    return echoNode(db, node);
  });
}

export function toolAbandon(db: Db, args: { id: string; reason?: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await abandonTask(db, id, args.reason);
    return echoNode(db, node);
  });
}

// ---------------------------------------------------------------------------
// Hold mutation tools
// ---------------------------------------------------------------------------

export function toolPark(db: Db, args: { id: string; reason?: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await parkTask(db, id, args.reason);
    return echoNode(db, node);
  });
}

export function toolUnpark(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await unparkTask(db, id);
    return echoNode(db, node);
  });
}

export function toolBlock(db: Db, args: { id: string; reason?: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await blockTask(db, id, args.reason);
    return echoNode(db, node);
  });
}

export function toolUnblock(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const node = await unblockTask(db, id);
    return echoNode(db, node);
  });
}

// ---------------------------------------------------------------------------
// Dependency mutation tools
// ---------------------------------------------------------------------------

export function toolDepend(db: Db, args: { id: string; on: string[] }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id);
    const onIds = await Promise.all(args.on.map((t) => nodeId(db, t)));
    const node = await depend(db, id, onIds);
    return echoNode(db, node);
  });
}

export function toolUndepend(db: Db, args: { id: string; on: string[] }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id);
    const onIds = await Promise.all(args.on.map((t) => nodeId(db, t)));
    const node = await undepend(db, id, onIds);
    return echoNode(db, node);
  });
}

// ---------------------------------------------------------------------------
// Structure mutation tools
// ---------------------------------------------------------------------------

export function toolMove(db: Db, args: { id: string; to: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id);
    const toId = await nodeId(db, args.to);
    const node = await moveNode(db, id, toId);
    return echoNode(db, node);
  });
}

export function toolReorder(
  db: Db,
  args: { id: string; position: "top" | "bottom" | "before" | "after"; ref?: string },
): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id, "task");
    const position: RankPosition = args.position;
    let refId: number | null = null;
    if (position === "before" || position === "after") {
      if (args.ref === undefined) {
        throw validation("reorder before/after requires ref");
      }
      refId = await nodeId(db, args.ref);
    }
    const node = await reorder(db, id, position, refId);
    return echoNode(db, node);
  });
}

// ---------------------------------------------------------------------------
// Data mutation tools
// ---------------------------------------------------------------------------

export function toolUpdate(
  db: Db,
  args: {
    id: string;
    title?: string;
    name?: string;
    description?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
  },
): Promise<ToolResult> {
  return guard(async () => {
    if (parseIdentity(args.id)?.kind === "artifact") {
      return updateArtifactTool(db, args);
    }
    if (parseIdentity(args.id)?.kind === "project") {
      return updateProjectTool(db, args);
    }
    const id = await nodeId(db, args.id);
    const fields: UpdateFields = {};
    if (args.title !== undefined) fields.title = args.title;
    if (args.description !== undefined) fields.description = args.description;
    if (args.priority !== undefined) fields.priority = args.priority as Priority;
    if (args.size !== undefined) fields.size = args.size as Size;
    if (args.target !== undefined) fields.target = args.target;
    if (args.externalRef !== undefined) fields.externalRef = args.externalRef;
    const node = await updateNode(db, id, fields);
    return echoNode(db, node);
  });
}

/** `update KEY` — patch a project's `name` and/or `description` (MMR-88). */
async function updateProjectTool(
  db: Db,
  args: {
    id: string;
    name?: string;
    description?: string;
    title?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
  },
): Promise<ToolResult> {
  const nodeOnly = (["title", "priority", "size", "target", "externalRef"] as const).filter(
    (k) => args[k] !== undefined,
  );
  if (nodeOnly.length > 0) {
    throw validation(
      `${nodeOnly.join(", ")} appl${nodeOnly.length === 1 ? "ies" : "y"} only to nodes — use name to rename a project`,
    );
  }
  const key = args.id;
  const pid = await projectId(db, key);
  const fields: UpdateProjectFields = {};
  if (args.name !== undefined) fields.name = args.name;
  if (args.description !== undefined) fields.description = args.description;
  await updateProject(db, pid, fields);
  // Echo the updated project through the same projection as getNode/get KEY
  const project = await db
    .selectFrom("project")
    .selectAll()
    .where("id", "=", pid)
    .executeTakeFirst();
  if (project === undefined) throw projectNotFound(key);
  return ok(formatNodeJson(await buildProjectView(db, project)));
}

/** `update` on a `KEY-aN` id — title is an artifact's one mutable field (MMR-40). */
async function updateArtifactTool(
  db: Db,
  args: {
    id: string;
    title?: string;
    description?: string;
    priority?: string;
    size?: string;
    target?: string;
    externalRef?: string;
  },
): Promise<ToolResult> {
  const nodeOnly = (["description", "priority", "size", "target", "externalRef"] as const).filter(
    (k) => args[k] !== undefined,
  );
  if (nodeOnly.length > 0) {
    throw validation(
      `${nodeOnly.join(", ")} appl${nodeOnly.length === 1 ? "ies" : "y"} only to nodes — title is an artifact's one mutable field`,
    );
  }
  const identity = parseIdentity(args.id);
  if (identity?.kind !== "artifact") throw notFound(`no artifact with id ${args.id}`);
  const artifact = await findArtifactByRef(db, identity);
  if (artifact === undefined) throw notFound(`no artifact ${args.id}`);
  if (args.title !== undefined) {
    await updateArtifact(db, artifact.id, { title: args.title });
  }
  return ok(formatArtifactJson(await getArtifact(db, args.id)));
}

export function toolAnnotate(db: Db, args: { id: string; content: string }): Promise<ToolResult> {
  return guard(async () => {
    const id = await nodeId(db, args.id);
    const node = await annotate(db, id, args.content);
    return echoNode(db, node);
  });
}

// ---------------------------------------------------------------------------
// Tag tools (MMR-31)
// ---------------------------------------------------------------------------

export function toolTag(
  db: Db,
  args: { ids: string[]; tags: string[]; note?: string },
): Promise<ToolResult> {
  return guard(async () => {
    if (args.ids.length === 0) throw validation("tag requires at least one id");
    if (args.tags.length === 0) throw validation("tag requires at least one tag");
    const targets = await Promise.all(args.ids.map((t) => resolveEntityToken(db, t)));
    await tagEntities(db, targets, args.tags, args.note);
    return ok(JSON.stringify({ tagged: { ids: args.ids, tags: args.tags } }));
  });
}

export function toolUntag(db: Db, args: { ids: string[]; tags: string[] }): Promise<ToolResult> {
  return guard(async () => {
    if (args.ids.length === 0) throw validation("untag requires at least one id");
    if (args.tags.length === 0) throw validation("untag requires at least one tag");
    const targets = await Promise.all(args.ids.map((t) => resolveEntityToken(db, t)));
    await untagEntities(db, targets, args.tags);
    return ok(JSON.stringify({ untagged: { ids: args.ids, tags: args.tags } }));
  });
}

// ---------------------------------------------------------------------------
// Create tool
// ---------------------------------------------------------------------------

export function toolCreate(
  db: Db,
  args: {
    type: "project" | "initiative" | "phase" | "task";
    key?: string;
    name?: string;
    parent?: string;
    title?: string;
    description?: string;
    target?: string;
    priority?: string;
    size?: string;
    externalRef?: string;
    tags?: string[];
  },
): Promise<ToolResult> {
  return guard(async () => {
    switch (args.type) {
      case "project": {
        if (args.key === undefined) throw validation("create project requires key");
        if (args.name === undefined) throw validation("create project requires name");
        const project = await createProject(db, {
          key: args.key,
          name: args.name,
          description: args.description,
          tags: args.tags,
        });
        return ok(JSON.stringify({ project: { key: project.key, name: project.name } }));
      }
      case "initiative": {
        if (args.title === undefined) throw validation("create initiative requires title");
        if (args.parent === undefined) throw validation("create initiative requires parent");
        // Initiative parent must be a bare project KEY (not a node ref)
        if (parseId(args.parent) !== null) {
          throw validation("an initiative's parent must be a project (KEY)");
        }
        const pid = await projectId(db, args.parent);
        const node = await createInitiative(db, {
          projectId: pid,
          title: args.title,
          description: args.description,
          tags: args.tags,
        });
        return echoNode(db, node);
      }
      case "phase": {
        if (args.title === undefined) throw validation("create phase requires title");
        if (args.parent === undefined) throw validation("create phase requires parent");
        // Phase parent must be a node ref (initiative)
        if (parseId(args.parent) === null) {
          throw validation("a phase's parent must be an initiative (KEY-seq)");
        }
        const parentNodeId = await nodeId(db, args.parent);
        const node = await createPhase(db, {
          parentId: parentNodeId,
          title: args.title,
          description: args.description,
          target: args.target,
          tags: args.tags,
        });
        return echoNode(db, node);
      }
      case "task": {
        if (args.title === undefined) throw validation("create task requires title");
        if (args.parent === undefined) throw validation("create task requires parent");
        // Task parent must be a node ref (phase or initiative)
        if (parseId(args.parent) === null) {
          throw validation("a task's parent must be a phase or initiative (KEY-seq)");
        }
        const parentNodeId = await nodeId(db, args.parent);
        const node = await createTask(db, {
          parentId: parentNodeId,
          title: args.title,
          description: args.description,
          priority: args.priority !== undefined ? (args.priority as Priority) : undefined,
          size: args.size !== undefined ? (args.size as Size) : undefined,
          externalRef: args.externalRef,
          tags: args.tags,
        });
        return echoNode(db, node);
      }
      default:
        throw validation(`create: unknown type ${String((args as { type: string }).type)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Attach tool
// ---------------------------------------------------------------------------

export function toolAttach(
  db: Db,
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
    if (args.node !== undefined) linkTokens.push(args.node);
    if (args.links !== undefined) {
      for (const t of args.links) {
        const trimmed = t.trim();
        if (trimmed.length > 0) linkTokens.push(trimmed);
      }
    }

    let pid: number;
    const linkNodeIds: number[] = [];

    if (linkTokens.length > 0) {
      // Resolve all node refs; require they all belong to one project
      const nodes = await Promise.all(
        linkTokens.map(async (t) => {
          const n = await findNodeByRef(db, t);
          if (n === undefined) throw notFound(`${t} doesn't exist`);
          return n;
        }),
      );
      const projects = new Set(nodes.map((n) => n.project_id));
      if (projects.size > 1) throw validation("all the links must be in one project");
      const [resolvedProjectId] = projects;
      if (resolvedProjectId === undefined)
        throw validation("internal: links resolved but project is missing");
      pid = resolvedProjectId;
      linkNodeIds.push(...nodes.map((n) => n.id));
      // If --project is also provided, it must agree
      if (args.project !== undefined) {
        const explicitId = await projectId(db, args.project);
        if (explicitId !== pid) throw validation("project disagrees with the links' project");
      }
    } else {
      // No links — project is required
      if (args.project === undefined)
        throw validation("attach requires a link (KEY-seq) or a project key");
      pid = await projectId(db, args.project);
    }

    const { renderedId } = await attachArtifact(db, {
      projectId: pid,
      title: args.title,
      content: args.content,
      linkNodeIds,
      tags: args.tags,
    });
    return ok(JSON.stringify({ artifact: { id: renderedId } }));
  });
}
