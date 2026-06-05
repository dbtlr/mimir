import type { Hold, Lifecycle } from "../contract/enums";
import type { Tx } from "./context";

/**
 * Rank mechanics (ADR 0007). `rank` is a single relative order, core-owned
 * (never exposed), dense over the **rankable set** — a task with
 * `lifecycle ∈ {todo, in_progress}` and `hold = none`, scoped per project.
 * Encoded as INTEGER-with-gaps: append is `MAX(rank) + STEP`; an insert between
 * neighbours takes their midpoint; when neighbours are adjacent a reindex
 * re-spreads the set (the rare O(n), amortized off the hot path).
 *
 * This module currently exposes membership + append (used by create / re-entry).
 * Reorder + reindex land in the rank-ops task.
 */
export const RANK_STEP = 65536;

/** A task is in the rankable set iff it is non-terminal and un-held. */
export function isRankable(lifecycle: Lifecycle, hold: Hold): boolean {
  return (lifecycle === "todo" || lifecycle === "in_progress") && hold === "none";
}

/** The next append-to-bottom rank for a project's rankable set: `MAX(rank) + STEP`, or `STEP` if empty. */
export async function appendRank(tx: Tx, projectId: number): Promise<number> {
  const row = await tx
    .selectFrom("node")
    .select((eb) => eb.fn.max("rank").as("maxRank"))
    .where("project_id", "=", projectId)
    .where("rank", "is not", null)
    .executeTakeFirst();
  const maxRank = row?.maxRank ?? null;
  return (maxRank ?? 0) + RANK_STEP;
}
