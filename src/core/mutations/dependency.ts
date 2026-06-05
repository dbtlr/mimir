import type { Node } from "../../db/schema";
import type { Db, Tx } from "../context";
import { validation } from "../errors";
import { renderNodeId } from "../lookup";
import { logTransition, reloadNode, requireNode, stamp } from "./common";

/**
 * Dependency-edge verbs (output contract). Edges produce the derived
 * `awaiting`/`blocking` — they are **not** the `block` hold. `depend` keeps the
 * graph acyclic; `undepend` removes edges. Both append `dependency`
 * transition-log rows.
 */

/** Can `startId` reach `targetId` by following `depends_on` edges? */
async function reaches(tx: Tx, startId: number, targetId: number): Promise<boolean> {
  const seen = new Set<number>();
  const stack: number[] = [startId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const edges = await tx
      .selectFrom("dependency")
      .select("depends_on_node_id")
      .where("node_id", "=", current)
      .execute();
    for (const edge of edges) {
      if (edge.depends_on_node_id === targetId) {
        return true;
      }
      stack.push(edge.depends_on_node_id);
    }
  }
  return false;
}

export async function depend(db: Db, id: number, onIds: number[]): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    for (const onId of onIds) {
      if (onId === id) {
        throw validation("a node cannot depend on itself");
      }
      await requireNode(tx, onId);
      // adding id → onId closes a cycle iff onId already reaches id
      if (await reaches(tx, onId, id)) {
        throw validation(`dependency would create a cycle (${String(id)} → ${String(onId)})`);
      }
      const existing = await tx
        .selectFrom("dependency")
        .select("node_id")
        .where("node_id", "=", id)
        .where("depends_on_node_id", "=", onId)
        .executeTakeFirst();
      if (existing === undefined) {
        await tx
          .insertInto("dependency")
          .values({ node_id: id, depends_on_node_id: onId })
          .execute();
        await logTransition(tx, {
          node_id: id,
          kind: "dependency",
          from_value: null,
          to_value: await renderNodeId(tx, onId),
        });
      }
    }
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function undepend(db: Db, id: number, onIds: number[]): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    for (const onId of onIds) {
      const deleted = await tx
        .deleteFrom("dependency")
        .where("node_id", "=", id)
        .where("depends_on_node_id", "=", onId)
        .executeTakeFirst();
      if (deleted.numDeletedRows > 0n) {
        await logTransition(tx, {
          node_id: id,
          kind: "dependency",
          from_value: await renderNodeId(tx, onId),
          to_value: null,
        });
      }
    }
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
