import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ZodRawShape, z } from "zod";
import type { FacetName } from "../contract";
import type { Db, ListOptions, NextOptions } from "../core";
import { type ToolResult, toolGet, toolList, toolNext, toolStatus } from "./tools";

/**
 * The MCP server — the agent envelope. Registers the read tools over the shared
 * intent layer and speaks JSON-RPC over stdio via the official SDK. Coarse and
 * curated: a handful of high-value tools, results rendered as the structured
 * `json` wire contract.
 */

const PRIORITY = z.enum(["p0", "p1", "p2", "p3"]);
const SIZE = z.enum(["small", "medium", "large"]);
const PREDICATE = z.enum(["all", "ready", "awaiting", "blocked", "stale", "blocking", "orphaned"]);
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

export function buildMcpServer(db: Db, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "mimir", version });

  register(
    server,
    "next",
    "Ready tasks in rank order — what to work on next. Optionally scope to a project key and filter by priority/size.",
    {
      scope: z.string().optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      limit: LIMIT.optional(),
    },
    (args: NextOptions) => toolNext(db, args),
  );

  register(
    server,
    "list",
    "Broad selection of non-terminal tasks by predicate (all|ready|awaiting|blocked|stale|blocking|orphaned), scope, or tag.",
    {
      scope: z.string().optional(),
      predicate: PREDICATE.optional(),
      priority: PRIORITY.optional(),
      size: SIZE.optional(),
      tag: z.string().optional(),
      limit: LIMIT.optional(),
    },
    (args: ListOptions) => toolList(db, args),
  );

  register(
    server,
    "get",
    "Full record for one node by KEY-seq id (e.g. MMR-16). Cheap facets are included; add `history` for the transition log.",
    { id: z.string(), facets: z.array(FACET).optional() },
    (args: { id: string; facets?: FacetName[] }) => toolGet(db, args),
  );

  register(
    server,
    "status",
    "A node's rollup distribution and single state word (KEY-seq id).",
    { id: z.string() },
    (args: { id: string }) => toolStatus(db, args),
  );

  return server;
}

/** Serve over stdio — the entry for `mimir mcp`. */
export async function serveStdio(db: Db, version?: string): Promise<void> {
  await buildMcpServer(db, version).connect(new StdioServerTransport());
}
