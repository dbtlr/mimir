/**
 * Shared resolution + echo helpers for every mutation handler. Resolves
 * human-readable `KEY-seq` / `KEY` tokens to surrogate ids and echoes the
 * affected node back to stdout in the requested format.
 */

import {
  buildNodeView,
  findNodeByRef,
  loadNode,
  notFound,
  parseIdentity,
  validation,
} from "../core";
import type { Db } from "../core";
import { type Format, type Io, renderNodeView } from "./render";

export type { Format };

/**
 * Resolve a node token to its surrogate integer id. Any rendered identity
 * parses (MMR-32); a token naming a project or artifact is rejected by the
 * verb as a behavioral error — `expected` names what the verb acts on.
 */
export async function resolveNode(db: Db, token: string, expected = "node"): Promise<number> {
  const identity = parseIdentity(token);
  if (identity?.kind === "project") {
    throw validation(`${token} is a project, not a ${expected}`);
  }
  if (identity?.kind === "artifact") {
    throw validation(`${token} is an artifact, not a ${expected}`);
  }
  const node = await findNodeByRef(db, token);
  if (node === undefined) {
    throw notFound(`no node ${token}`, "list ids with: mimir list -f ids");
  }
  return node.id;
}

/**
 * Resolve a bare project KEY to its surrogate integer id. Throws `not_found`
 * (MimirError) if no project with that key exists.
 */
export async function resolveProject(db: Db, key: string): Promise<number> {
  const row = await db.selectFrom("project").select("id").where("key", "=", key).executeTakeFirst();
  if (row === undefined) {
    throw notFound(`no project ${key}`);
  }
  return row.id;
}

/**
 * Resolve a parent token — either a bare project KEY or a `KEY-seq` node
 * reference — returning a tagged id so the caller knows which table to target.
 */
export async function resolveParent(
  db: Db,
  token: string,
): Promise<{ kind: "project"; id: number } | { kind: "node"; id: number }> {
  const identity = parseIdentity(token);
  if (identity?.kind === "artifact") {
    throw validation(`${token} is an artifact — a parent must be a project KEY or node (KEY-seq)`);
  }
  if (identity?.kind === "node") {
    return { kind: "node", id: await resolveNode(db, token) };
  }
  return { kind: "project", id: await resolveProject(db, token) };
}

/**
 * Echo the affected node to stdout in the requested format. Accepts the
 * surrogate integer id (as returned by `resolveNode`), loads the row, and
 * projects it to a view. Matches the single-node renderer semantics of
 * `renderSingle` in `run.ts`.
 */
export async function echoNode(db: Db, nodeId: number, format: Format, io: Io): Promise<void> {
  const node = await loadNode(db, nodeId);
  if (node === undefined) {
    throw notFound("node vanished before echo");
  }
  const view = await buildNodeView(db, node);
  renderNodeView(view, format, io);
}

/**
 * Read inline content from the trailing positionals or from stdin (when
 * piped). Returns an empty string if both sources are absent (interactive
 * TTY with no tail args — callers decide how to handle the gap).
 */
export async function readContent(tail: string[], io: Io): Promise<string> {
  if (tail.length > 0) return tail.join(" ");
  if (!io.isTTY) return (await Bun.stdin.text()).trim();
  return "";
}
