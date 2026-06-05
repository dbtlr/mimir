import type { Hold } from "../../contract/enums";
import type { Node } from "../../db/schema";
import type { Db } from "../context";
import { validation } from "../errors";
import { appendRank } from "../rank";
import { logTransition, reloadNode, requireTask, stamp } from "./common";

/**
 * Hold verbs (ADR 0001/0007). The hold overlay is orthogonal to lifecycle: a
 * task keeps its lifecycle position while held. Entering a hold (`park`/`block`)
 * leaves the rankable set → clears `rank`; releasing it (`unpark`/`unblock`)
 * re-enters → appends to the bottom (no remembered position; a re-entry is a
 * natural re-triage point).
 */

function assertHoldable(task: Node): void {
  if (task.lifecycle === "done" || task.lifecycle === "abandoned") {
    throw validation(`cannot hold a ${task.lifecycle} task`);
  }
}

async function enterHold(
  db: Db,
  id: number,
  to: Exclude<Hold, "none">,
  reason?: string,
): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    assertHoldable(task);
    if (task.hold !== "none") {
      throw validation(`task is already ${task.hold}`);
    }
    await tx
      .updateTable("node")
      .set({ hold: to, hold_reason: reason ?? null, rank: null })
      .where("id", "=", id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: "hold",
      from_value: "none",
      to_value: to,
      reason: reason ?? null,
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

async function releaseHold(db: Db, id: number, from: Exclude<Hold, "none">): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.hold !== from) {
      throw validation(`task is not ${from} (is ${String(task.hold)})`);
    }
    // re-enter the rankable set at the bottom (lifecycle is non-terminal — a held task can't be terminal)
    const rank = await appendRank(tx, task.project_id);
    await tx
      .updateTable("node")
      .set({ hold: "none", hold_reason: null, rank })
      .where("id", "=", id)
      .execute();
    await logTransition(tx, { node_id: id, kind: "hold", from_value: from, to_value: "none" });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export const parkTask = (db: Db, id: number, reason?: string): Promise<Node> =>
  enterHold(db, id, "parked", reason);

export const unparkTask = (db: Db, id: number): Promise<Node> => releaseHold(db, id, "parked");

export const blockTask = (db: Db, id: number, reason?: string): Promise<Node> =>
  enterHold(db, id, "blocked", reason);

export const unblockTask = (db: Db, id: number): Promise<Node> => releaseHold(db, id, "blocked");
