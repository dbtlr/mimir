import type { TagEntityType } from "../contract/enums";
import type { Artifact, Node } from "../db/schema";
import type { Db, Tx } from "./context";
import { notFound } from "./errors";
import { parseId, parseIdentity, renderArtifactRef, renderId } from "./ids";

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

/** Resolve a parsed `KEY-aN` artifact identity to its row, or `undefined` if absent. */
export async function findArtifactByRef(
  tx: Db | Tx,
  ref: { key: string; seq: number },
): Promise<Artifact | undefined> {
  const project = await tx
    .selectFrom("project")
    .select("id")
    .where("key", "=", ref.key)
    .executeTakeFirst();
  if (project === undefined) {
    return undefined;
  }
  return tx
    .selectFrom("artifact")
    .selectAll()
    .where("project_id", "=", project.id)
    .where("seq", "=", ref.seq)
    .executeTakeFirst();
}

/**
 * Resolve any rendered identity — `KEY` | `KEY-seq` | `KEY-aN` — to its tag
 * target (entity kind + surrogate id). Throws `not_found` naming the token;
 * the caller decides which kinds it acts on.
 */
export async function resolveEntityToken(
  tx: Db | Tx,
  token: string,
): Promise<{ entityType: TagEntityType; entityId: number }> {
  const identity = parseIdentity(token);
  if (identity === null) {
    throw notFound(
      `no such id ${token}`,
      "ids are KEY (project), KEY-seq (node), KEY-aN (artifact)",
    );
  }
  if (identity.kind === "project") {
    const project = await tx
      .selectFrom("project")
      .select("id")
      .where("key", "=", identity.key)
      .executeTakeFirst();
    if (project === undefined) throw notFound(`no project ${token}`);
    return { entityType: "project", entityId: project.id };
  }
  if (identity.kind === "artifact") {
    const artifact = await findArtifactByRef(tx, identity);
    if (artifact === undefined) throw notFound(`no artifact ${token}`);
    return { entityType: "artifact", entityId: artifact.id };
  }
  const node = await findNodeByRef(tx, token);
  if (node === undefined) throw notFound(`no node ${token}`);
  return { entityType: "node", entityId: node.id };
}

/** Render an artifact's external `KEY-aN` id from its surrogate id (joins the project key). */
export async function renderArtifactId(tx: Db | Tx, artifactId: number): Promise<string | null> {
  const row = await tx
    .selectFrom("artifact")
    .innerJoin("project", "project.id", "artifact.project_id")
    .select(["project.key as key", "artifact.seq as seq"])
    .where("artifact.id", "=", artifactId)
    .executeTakeFirst();
  return row === undefined ? null : renderArtifactRef(row);
}
