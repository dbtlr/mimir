import type { Node } from "../../db/schema";
import type { Db } from "../context";
import { validation } from "../errors";
import { now } from "../time";
import { logTransition, reloadNode, requireTask, stamp } from "./common";

/**
 * Lifecycle verbs (ADR 0001/0003/0007). `start` keeps the task in the rankable
 * set (todo→in_progress, un-held); `done`/`abandon` are terminal and leave it,
 * clearing `rank`. `done` stamps `completed_at`; `abandon` carries its reason on
 * the transition-log row. Hold is left untouched on terminal transitions — the
 * State word projects to `done`/`abandoned` regardless, and the history records
 * what the hold was.
 */

export async function startTask(db: Db, id: number): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle !== "todo") {
      throw validation(`only a todo task can be started (is ${String(task.lifecycle)})`);
    }
    await tx.updateTable("node").set({ lifecycle: "in_progress" }).where("id", "=", id).execute();
    await logTransition(tx, {
      node_id: id,
      kind: "lifecycle",
      from_value: "todo",
      to_value: "in_progress",
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function completeTask(db: Db, id: number): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle === "done" || task.lifecycle === "abandoned") {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await tx
      .updateTable("node")
      .set({ lifecycle: "done", completed_at: now(), rank: null })
      .where("id", "=", id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: "lifecycle",
      from_value: task.lifecycle,
      to_value: "done",
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function abandonTask(db: Db, id: number, reason?: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle === "done" || task.lifecycle === "abandoned") {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await tx
      .updateTable("node")
      .set({ lifecycle: "abandoned", rank: null })
      .where("id", "=", id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: "lifecycle",
      from_value: task.lifecycle,
      to_value: "abandoned",
      reason: reason ?? null,
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
