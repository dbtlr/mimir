import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ZodRawShape, z } from "zod";
import { STATUS_SELECTOR_VALUES, VERDICT_VALUES } from "../contract";
import type { FacetName } from "../contract";
import type { Db } from "../core";
import {
  type SetQueryArgs,
  type ToolResult,
  toolAnnotate,
  toolAttach,
  toolAbandon,
  toolBlock,
  toolCreate,
  toolDepend,
  toolDone,
  toolGet,
  toolList,
  toolMove,
  toolNext,
  toolPark,
  toolReorder,
  toolStart,
  toolStatus,
  toolTag,
  toolUnblock,
  toolUndepend,
  toolUnpark,
  toolUntag,
  toolUpdate,
} from "./tools";

/**
 * The MCP server — the agent envelope. Registers read + write tools over the
 * shared intent layer and speaks JSON-RPC over stdio via the official SDK.
 * Results are the structured `json` wire contract; errors use the structured
 * envelope `{"error":{"code","message","hint?"}}`.
 */

const PRIORITY = z.enum(["p0", "p1", "p2", "p3"]);
const SIZE = z.enum(["small", "medium", "large"]);
const STATUS = z.enum(STATUS_SELECTOR_VALUES);
const VERDICT = z.enum(VERDICT_VALUES);
const TOKENS = z.array(z.string());
// Field operators (MMR-33): FIELD:VALUE tokens (bare FIELD for has/missing).
const OPERATOR_SCHEMA = {
  eq: TOKENS.optional(),
  notEq: TOKENS.optional(),
  in: TOKENS.optional(),
  notIn: TOKENS.optional(),
  has: TOKENS.optional(),
  missing: TOKENS.optional(),
  before: TOKENS.optional(),
  on: TOKENS.optional(),
  after: TOKENS.optional(),
  notBefore: TOKENS.optional(),
  notAfter: TOKENS.optional(),
  is: z.array(VERDICT).optional(),
  notIs: z.array(VERDICT).optional(),
};
const FACET = z.enum([
  "deps",
  "annotations",
  "artifacts",
  "history",
  "tags",
  "children",
  "distribution",
]);
const LIMIT = z.number().int().positive();

/**
 * Register a tool with its `inputSchema` widened to the base `ZodRawShape`. The
 * concrete zod validators still run at runtime; widening only stops the SDK's
 * per-field generic inference from recursing past the type-checker's depth
 * limit (TS2589). The handler casts the validated args to its known shape.
 */
type RegisterFn = (
  name: string,
  config: { description: string; inputSchema: ZodRawShape },
  cb: (args: unknown) => Promise<ToolResult>,
) => void;

function register<A>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: (args: A) => Promise<ToolResult>,
): void {
  // Bind to a concrete, non-generic signature so the type-checker doesn't
  // instantiate registerTool's deep per-field generics (TS2589); `this` is
  // preserved by bind, and zod still validates at runtime.
  const registerTool = server.registerTool.bind(server) as unknown as RegisterFn;
  registerTool(name, { description, inputSchema }, (args) => handler(args as A));
}

export function buildMcpServer(db: Db, version: string): McpServer {
  const server = new McpServer({ name: "mimir", version });

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "next",
    "Ready tasks in rank order — what to work on next. Optionally scope to a project key; filter by priority/size, verdicts (is/notIs: stale|blocking|orphaned), and field operators (eq/notEq/in/notIn/has/missing + date ops, FIELD:VALUE tokens). Value faults return an empty set plus a warnings array.",
    {
      scope: z.string().optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      limit: LIMIT.optional(),
      ...OPERATOR_SCHEMA,
    },
    (args: SetQueryArgs) => toolNext(db, args),
  );

  register(
    server,
    "list",
    "Broad selection: status picks the universe (ready|awaiting|in_progress|blocked|parked|done|abandoned or live|terminal|all; default live), verdicts (is/notIs) and field operators (FIELD:VALUE tokens) filter within it — all AND-composed. Value faults return an empty set plus a warnings array.",
    {
      scope: z.string().optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      tag: z.string().optional(),
      limit: LIMIT.optional(),
      ...OPERATOR_SCHEMA,
    },
    (args: SetQueryArgs) => toolList(db, args),
  );

  register(
    server,
    "get",
    "Full record by rendered id: a node (KEY-seq, e.g. MMR-16), a whole project (bare KEY), or an artifact (KEY-aN). Cheap facets are included for nodes/projects; add `history` for the transition log.",
    { id: z.string(), facets: z.array(FACET).optional() },
    (args: { id: string; facets?: FacetName[] }) => toolGet(db, args),
  );

  register(
    server,
    "status",
    "A rollup distribution and single status word, for a node (KEY-seq) or a whole project (bare KEY).",
    { id: z.string() },
    (args: { id: string }) => toolStatus(db, args),
  );

  // ---------------------------------------------------------------------------
  // Lifecycle mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "start",
    "Move a todo task to in_progress. Echoes the updated node. Use before beginning active work.",
    { id: z.string() },
    (args: { id: string }) => toolStart(db, args),
  );

  register(
    server,
    "done",
    "Mark an in_progress (or todo) task as done. Terminal — removes from rankable set. Echoes the updated node.",
    { id: z.string() },
    (args: { id: string }) => toolDone(db, args),
  );

  register(
    server,
    "abandon",
    "Mark a task as abandoned with an optional reason. Terminal — removes from rankable set. Echoes the updated node.",
    { id: z.string(), reason: z.string().optional() },
    (args: { id: string; reason?: string }) => toolAbandon(db, args),
  );

  // ---------------------------------------------------------------------------
  // Hold mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "park",
    "Apply a 'parked' hold to a task (voluntary deprioritisation) with an optional reason. Echoes the updated node.",
    { id: z.string(), reason: z.string().optional() },
    (args: { id: string; reason?: string }) => toolPark(db, args),
  );

  register(
    server,
    "unpark",
    "Release a parked hold, re-entering the task at the bottom of the rankable set. Echoes the updated node.",
    { id: z.string() },
    (args: { id: string }) => toolUnpark(db, args),
  );

  register(
    server,
    "block",
    "Apply a 'blocked' hold to a task (external impediment) with an optional reason. Echoes the updated node.",
    { id: z.string(), reason: z.string().optional() },
    (args: { id: string; reason?: string }) => toolBlock(db, args),
  );

  register(
    server,
    "unblock",
    "Release a blocked hold, re-entering the task at the bottom of the rankable set. Echoes the updated node.",
    { id: z.string() },
    (args: { id: string }) => toolUnblock(db, args),
  );

  // ---------------------------------------------------------------------------
  // Dependency mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "depend",
    "Add dependency edges: id depends on each node in `on`. Acyclic — cycle attempts error. Echoes the subject node.",
    { id: z.string(), on: z.array(z.string()) },
    (args: { id: string; on: string[] }) => toolDepend(db, args),
  );

  register(
    server,
    "undepend",
    "Remove dependency edges from id to each node in `on`. Echoes the subject node.",
    { id: z.string(), on: z.array(z.string()) },
    (args: { id: string; on: string[] }) => toolUndepend(db, args),
  );

  // ---------------------------------------------------------------------------
  // Structure mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "move",
    "Re-parent a node under a new parent (within the same project). Echoes the moved node.",
    { id: z.string(), to: z.string() },
    (args: { id: string; to: string }) => toolMove(db, args),
  );

  register(
    server,
    "reorder",
    "Change a task's rank position (top|bottom|before|after). `ref` is required for before/after. Echoes the task.",
    {
      id: z.string(),
      position: z.enum(["top", "bottom", "before", "after"]),
      ref: z.string().optional(),
    },
    (args: { id: string; position: "top" | "bottom" | "before" | "after"; ref?: string }) =>
      toolReorder(db, args),
  );

  // ---------------------------------------------------------------------------
  // Data mutation tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "update",
    "Patch a node's scalar fields (title, description, priority, size, target, externalRef). Echoes the updated node.",
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      target: z.string().optional(),
      externalRef: z.string().optional(),
    },
    (args: {
      id: string;
      title?: string;
      description?: string;
      priority?: string;
      size?: string;
      target?: string;
      externalRef?: string;
    }) => toolUpdate(db, args),
  );

  register(
    server,
    "annotate",
    "Append a freeform annotation to a node. Echoes the updated node.",
    { id: z.string(), content: z.string() },
    (args: { id: string; content: string }) => toolAnnotate(db, args),
  );

  // ---------------------------------------------------------------------------
  // Tag tools (MMR-31)
  // ---------------------------------------------------------------------------

  register(
    server,
    "tag",
    "Apply free-text tags to entities by rendered id (project KEY, node KEY-seq, artifact KEY-aN). Idempotent; optional note rides the application. Not transition-logged.",
    {
      ids: z.array(z.string()).min(1),
      tags: z.array(z.string()).min(1),
      note: z.string().optional(),
    },
    (args: { ids: string[]; tags: string[]; note?: string }) => toolTag(db, args),
  );

  register(
    server,
    "untag",
    "Remove tags from entities by rendered id. A plain row delete — not transition-logged.",
    { ids: z.array(z.string()).min(1), tags: z.array(z.string()).min(1) },
    (args: { ids: string[]; tags: string[] }) => toolUntag(db, args),
  );

  // ---------------------------------------------------------------------------
  // Create tool
  // ---------------------------------------------------------------------------

  register(
    server,
    "create",
    "Create a node of the given type. project: requires key+name, echoes {project:{key,name}}. initiative: requires title+parent (project KEY). phase/task: requires title+parent (KEY-seq node ref). Echoes the created node.",
    {
      type: z.enum(["project", "initiative", "phase", "task"]),
      key: z.string().optional(),
      name: z.string().optional(),
      repo: z.string().optional(),
      path: z.string().optional(),
      parent: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      target: z.string().optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      externalRef: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    (args: {
      type: "project" | "initiative" | "phase" | "task";
      key?: string;
      name?: string;
      repo?: string;
      path?: string;
      parent?: string;
      title?: string;
      description?: string;
      target?: string;
      priority?: string;
      size?: string;
      externalRef?: string;
      tags?: string[];
    }) => toolCreate(db, args),
  );

  // ---------------------------------------------------------------------------
  // Attach tool
  // ---------------------------------------------------------------------------

  register(
    server,
    "attach",
    "Store a frozen artifact (content string) and optionally link it to nodes. Infers project from linked nodes. Echoes {artifact:{id}} with the rendered KEY-aN id.",
    {
      content: z.string(),
      node: z.string().optional(),
      project: z.string().optional(),
      links: z.array(z.string()).optional(),
    },
    (args: { content: string; node?: string; project?: string; links?: string[] }) =>
      toolAttach(db, args),
  );

  return server;
}

/** Serve over stdio — the entry for `mimir mcp`. */
export async function serveStdio(db: Db, version: string): Promise<void> {
  await buildMcpServer(db, version).connect(new StdioServerTransport());
}
