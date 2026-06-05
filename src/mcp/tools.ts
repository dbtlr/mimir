import { CHEAP_FACETS, type FacetName } from "../contract";
import {
  type ListOptions,
  MimirError,
  type NextOptions,
  formatNodeJson,
  formatSetJson,
  formatStatusJson,
  getNode,
  listNodes,
  nextTasks,
  statusOfNode,
} from "../core";
import type { Db } from "../core";

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
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Map a thrown {@link MimirError} to an `isError` result; rethrow anything else. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MimirError) {
      return fail(`error: ${error.message}`);
    }
    throw error;
  }
}

export function toolNext(db: Db, args: NextOptions): Promise<ToolResult> {
  return guard(async () => ok(formatSetJson(await nextTasks(db, args))));
}

export function toolList(db: Db, args: ListOptions): Promise<ToolResult> {
  return guard(async () => ok(formatSetJson(await listNodes(db, args))));
}

export function toolGet(db: Db, args: { id: string; facets?: FacetName[] }): Promise<ToolResult> {
  return guard(async () => {
    const facets =
      args.facets !== undefined && args.facets.length > 0
        ? [...new Set<FacetName>([...CHEAP_FACETS, ...args.facets])]
        : undefined;
    return ok(formatNodeJson(await getNode(db, args.id, { facets })));
  });
}

export function toolStatus(db: Db, args: { id: string }): Promise<ToolResult> {
  return guard(async () => ok(formatStatusJson(await statusOfNode(db, args.id))));
}
