import type { Hold, Lifecycle } from '@mimir/contract';

import { invariant, validation } from './errors';
import type { StoreWriter } from './store';

/**
 * Rank mechanics (ADR 0007). `rank` is a single relative order, core-owned
 * (never exposed), dense over the **rankable set** — a task with
 * `lifecycle ∈ {todo, in_progress}` and `hold = none`, scoped per project.
 * Encoded as INTEGER-with-gaps: append is `MAX(rank) + STEP`; an insert between
 * neighbours takes their midpoint; when neighbours are adjacent `reindexRanks`
 * re-spreads the set (the rare O(n), amortized off the hot path, with an
 * on-the-spot reindex as the safety valve so correctness never waits).
 *
 * The helpers run inside a verb's write scope (`StoreWriter`), reading the
 * ranked set fresh per step so interleaved updates are always visible.
 */
export const RANK_STEP = 65536;

/** Where to place a task relative to the rankable set. */
export type RankPosition = 'top' | 'bottom' | 'before' | 'after';

/**
 * A task is in the rankable set iff it is non-terminal, un-held, and actionable.
 * `under_review` is non-terminal but *not* actionable (the verdict is the human's,
 * not the agent's), so it is excluded. Tolerates `null` (a container) → false.
 */
export function isRankable(lifecycle: Lifecycle | null, hold: Hold | null): boolean {
  return (lifecycle === 'todo' || lifecycle === 'in_progress') && hold === 'none';
}

/** The single integer strictly between two ranks, or `null` if they are adjacent. */
function midpoint(lo: number, hi: number): number | null {
  const mid = Math.floor((lo + hi) / 2);
  return mid > lo && mid < hi ? mid : null;
}

async function maxRank(w: StoreWriter, projectId: number): Promise<number | null> {
  const ranked = await w.listRankedTasks(projectId);
  return ranked.at(-1)?.rank ?? null;
}

async function minRank(w: StoreWriter, projectId: number): Promise<number | null> {
  const ranked = await w.listRankedTasks(projectId);
  return ranked[0]?.rank ?? null;
}

/** The rank immediately below (largest `< pivot`) or above (smallest `> pivot`) a pivot, within a project. */
async function adjacentRank(
  w: StoreWriter,
  projectId: number,
  pivot: number,
  direction: 'below' | 'above',
): Promise<number | null> {
  const ranks = (await w.listRankedTasks(projectId)).map((r) => r.rank);
  if (direction === 'below') {
    const below = ranks.filter((r) => r < pivot);
    return below.at(-1) ?? null;
  }
  return ranks.find((r) => r > pivot) ?? null;
}

/** The next append-to-bottom rank for a project's rankable set: `MAX(rank) + STEP`, or `STEP` if empty. */
export async function appendRank(w: StoreWriter, projectId: number): Promise<number> {
  return ((await maxRank(w, projectId)) ?? 0) + RANK_STEP;
}

/**
 * Re-spread a project's rankable set to clean multiples of `RANK_STEP`,
 * preserving order (rank asc, `seq` asc as a stable tiebreak). Idempotent — a
 * second run is a no-op. The deliberate O(n), bounded to one project's
 * actionable tasks; rank is invisible to consumers, so this does not touch
 * `updated_at`.
 */
export async function reindexRanks(w: StoreWriter, projectId: number): Promise<void> {
  const ranked = await w.listRankedTasks(projectId);
  let next = RANK_STEP;
  for (const row of ranked) {
    await w.updateNode(row.id, { rank: next });
    next += RANK_STEP;
  }
}

/**
 * Move a ranked task to a position relative to the rankable set, updating only
 * its `rank`. `top`/`bottom` go beyond the current extent; `before`/`after`
 * take the midpoint against the reference's neighbour, reindexing once if the
 * neighbours are adjacent (the safety valve). Assumes the task — and `refId`
 * for before/after — are in the rankable set (the verb validates).
 */
export async function reorderTask(
  w: StoreWriter,
  projectId: number,
  taskId: number,
  position: RankPosition,
  refId: number | null,
): Promise<void> {
  const rank = await computeTargetRank(w, projectId, taskId, position, refId, true);
  await w.updateNode(taskId, { rank });
}

async function rankOf(w: StoreWriter, taskId: number): Promise<number> {
  const node = await w.loadNode(taskId);
  if (node?.rank == null) {
    throw validation(`task ${String(taskId)} is not in the rankable set`);
  }
  return node.rank;
}

async function computeTargetRank(
  w: StoreWriter,
  projectId: number,
  taskId: number,
  position: RankPosition,
  refId: number | null,
  allowReindex: boolean,
): Promise<number> {
  if (position === 'bottom') {
    return ((await maxRank(w, projectId)) ?? 0) + RANK_STEP;
  }
  if (position === 'top') {
    const min = await minRank(w, projectId);
    return min === null ? RANK_STEP : min - RANK_STEP;
  }

  // before / after — relative to a reference task
  if (refId === null) {
    throw validation(`'${position}' requires a reference task`);
  }
  if (refId === taskId) {
    throw validation('cannot position a task relative to itself');
  }
  const refRank = await rankOf(w, refId);
  const neighbor = await adjacentRank(
    w,
    projectId,
    refRank,
    position === 'before' ? 'below' : 'above',
  );
  if (neighbor === null) {
    // reference sits at an edge — step beyond it
    return position === 'before' ? refRank - RANK_STEP : refRank + RANK_STEP;
  }
  const mid = midpoint(Math.min(refRank, neighbor), Math.max(refRank, neighbor));
  if (mid !== null) {
    return mid;
  }
  if (!allowReindex) {
    throw invariant('rank exhausted even after reindex');
  }
  // neighbours adjacent → re-spread once and recompute against fresh ranks
  await reindexRanks(w, projectId);
  return computeTargetRank(w, projectId, taskId, position, refId, false);
}
