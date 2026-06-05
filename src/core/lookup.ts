import type { Node } from "../db/schema";
import type { Db, Tx } from "./context";
import { parseId, renderId } from "./ids";

/** Load a node row by surrogate id, or `undefined` if absent. */
export async function loadNode(tx: Db | Tx, id: number): Promise<Node | undefined> {
  return tx.selectFrom("node").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * Resolve an external `KEY-seq` id to its node row. The surrogate int is never
 * exposed, so this is how transports turn a user-facing id back into a node.
 * Returns `undefined` for a malformed id or an unknown key/seq.
 */
export async function findNodeByRef(tx: Db | Tx, id: string): Promise<Node | undefined> {
  const ref = parseId(id);
  if (ref === null) {
    return undefined;
  }
  const project = await tx
    .selectFrom("project")
    .select("id")
    .where("key", "=", ref.key)
    .executeTakeFirst();
  if (project === undefined) {
    return undefined;
  }
  return tx
    .selectFrom("node")
    .selectAll()
    .where("project_id", "=", project.id)
    .where("seq", "=", ref.seq)
    .executeTakeFirst();
}

/** Render a node's external `KEY-seq` id from its surrogate id (joins the project key). */
export async function renderNodeId(tx: Db | Tx, nodeId: number): Promise<string | null> {
  const row = await tx
    .selectFrom("node")
    .innerJoin("project", "project.id", "node.project_id")
    .select(["project.key as key", "node.seq as seq"])
    .where("node.id", "=", nodeId)
    .executeTakeFirst();
  return row === undefined ? null : renderId(row);
}
