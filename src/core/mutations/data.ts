import type { Priority, Size } from "../../contract/enums";
import type { Node, NodeUpdate } from "../../db/schema";
import type { Db } from "../context";
import { notFound, validation } from "../errors";
import { type RankPosition, reorderTask } from "../rank";
import { now } from "../time";
import { reloadNode, requireNode, requireTask, stamp } from "./common";

/**
 * Data + structural-order verbs that aren't status-bearing: the dumb `update`
 * patch (status axes / rank / seq / type / parent deliberately excluded — those
 * have their own verbs), freeform annotations, frozen artifacts, and `reorder`
 * (a pure rank change — no transition log, and `rank` is invisible so it does
 * not stamp `updated_at`).
 */

export interface UpdateFields {
  title?: string;
  description?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  target?: string | null;
  externalRef?: string | null;
}

export async function updateNode(db: Db, id: number, fields: UpdateFields): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const node = await requireNode(tx, id);

    const wantsTaskField =
      fields.priority !== undefined ||
      fields.size !== undefined ||
      fields.externalRef !== undefined;
    if (wantsTaskField && node.type !== "task") {
      throw validation("priority, size, and external_ref apply only to tasks");
    }
    if (fields.target !== undefined && node.type !== "phase") {
      throw validation("target applies only to phases");
    }

    const patch: NodeUpdate = {};
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.description !== undefined) patch.description = fields.description;
    if (fields.priority !== undefined) patch.priority = fields.priority;
    if (fields.size !== undefined) patch.size = fields.size;
    if (fields.target !== undefined) patch.target = fields.target;
    if (fields.externalRef !== undefined) patch.external_ref = fields.externalRef;

    if (Object.keys(patch).length > 0) {
      patch.updated_at = now();
      await tx.updateTable("node").set(patch).where("id", "=", id).execute();
    }
    return reloadNode(tx, id);
  });
}

export async function annotate(db: Db, id: number, content: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    await tx.insertInto("annotation").values({ node_id: id, content }).execute();
    await stamp(tx, id); // in-flight activity moves the task (affects stale)
    return reloadNode(tx, id);
  });
}

export interface AttachArtifactInput {
  projectId: number;
  content: string;
  linkNodeIds?: number[];
}

export async function attachArtifact(db: Db, input: AttachArtifactInput): Promise<{ id: number }> {
  return db.transaction().execute(async (tx) => {
    const project = await tx
      .selectFrom("project")
      .select("id")
      .where("id", "=", input.projectId)
      .executeTakeFirst();
    if (project === undefined) {
      throw notFound(`project ${String(input.projectId)} not found`);
    }
    const artifact = await tx
      .insertInto("artifact")
      .values({ project_id: input.projectId, content: input.content })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const nodeId of input.linkNodeIds ?? []) {
      const node = await requireNode(tx, nodeId);
      if (node.project_id !== input.projectId) {
        throw validation(`linked node ${String(nodeId)} is in a different project`);
      }
      await tx
        .insertInto("artifact_link")
        .values({ artifact_id: artifact.id, node_id: nodeId })
        .execute();
    }
    return { id: artifact.id };
  });
}

export async function reorder(
  db: Db,
  id: number,
  position: RankPosition,
  refId: number | null = null,
): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.rank === null) {
      throw validation("cannot reorder a task outside the rankable set (terminal or held)");
    }
    await reorderTask(tx, task.project_id, id, position, refId);
    return reloadNode(tx, id);
  });
}
