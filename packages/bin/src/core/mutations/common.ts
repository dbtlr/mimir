import type { NewTransitionRow, Node } from "../../db/schema";
import type { Tx } from "../context";
import { invariant, notFound, validation } from "../errors";
import { renderNodeId } from "../lookup";
import { isReady } from "../predicates";
import { now } from "../time";

/**
 * Shared machinery for the mutation verbs. Every status-bearing verb is one
 * transaction: load → validate the behavioral invariant → write the column(s)
 * → append a `transition_log` row → adjust rank → stamp `updated_at` → echo the
 * affected node (ADR 0003). These helpers are the reusable steps.
 */

/** Reload a node that must exist (post-write echo / mid-verb refresh). */
export async function reloadNode(tx: Tx, id: number): Promise<Node> {
  const node = await tx.selectFrom("node").selectAll().where("id", "=", id).executeTakeFirst();
  if (node === undefined) {
    throw invariant("node vanished mid-transaction");
  }
  return node;
}

/** Load a node by id, asserting it exists. */
export async function requireNode(tx: Tx, id: number): Promise<Node> {
  const node = await tx.selectFrom("node").selectAll().where("id", "=", id).executeTakeFirst();
  if (node === undefined) {
    throw notFound("node not found");
  }
  return node;
}

/**
 * Collect ready descendant task ids under a container node, for actionable hints.
 * Walks all tasks in the same project, checks parent chain for containment, then
 * readiness (dependency settlement). Returns rendered ids like ["MMR-3", "MMR-4"].
 */
async function readyDescendantIds(tx: Tx, container: Node): Promise<string[]> {
  const candidates = await tx
    .selectFrom("node")
    .selectAll()
    .where("project_id", "=", container.project_id)
    .where("type", "=", "task")
    .where("lifecycle", "=", "todo")
    .where("hold", "=", "none")
    .where("rank", "is not", null)
    .execute();

  const ids: string[] = [];
  for (const task of candidates) {
    // Walk parent chain to check containment.
    let cur: number | null = task.parent_id;
    let isDescendant = false;
    while (cur !== null) {
      if (cur === container.id) {
        isDescendant = true;
        break;
      }
      const row = await tx
        .selectFrom("node")
        .select("parent_id")
        .where("id", "=", cur)
        .executeTakeFirst();
      cur = row?.parent_id ?? null;
    }
    if (!isDescendant) continue;
    if (!(await isReady(tx, task))) continue;
    const rendered = await renderNodeId(tx, task.id);
    if (rendered !== null) ids.push(rendered);
  }
  return ids;
}

/** Load a node, asserting it is a task (verbs that touch lifecycle/hold/rank). */
export async function requireTask(tx: Tx, id: number): Promise<Node> {
  const node = await requireNode(tx, id);
  if (node.type !== "task") {
    const rendered = (await renderNodeId(tx, id)) ?? "node";
    const article = node.type === "initiative" ? "an" : "a";
    const readyIds = await readyDescendantIds(tx, node);
    const hint =
      readyIds.length > 0
        ? `containers aren't started directly — start a ready task under it: ${readyIds.join(", ")}`
        : `containers aren't started directly — no ready tasks under it; see its shape with 'mimir tree ${rendered}'`;
    throw validation(`${rendered} is ${article} ${node.type}, not a task`, hint);
  }
  return node;
}

/** Stamp `updated_at` on a node — the core is the sole time-maintainer (not a trigger). */
export async function stamp(tx: Tx, id: number): Promise<void> {
  await tx.updateTable("node").set({ updated_at: now() }).where("id", "=", id).execute();
}

/** Append a transition-log row in the verb's own transaction (so columns + log can't drift). */
export async function logTransition(tx: Tx, row: NewTransitionRow): Promise<void> {
  await tx.insertInto("transition_log").values(row).execute();
}
