import type { Hold, Lifecycle } from '@mimir/contract';

import type { Tx } from './context';
import { invariant, validation } from './errors';

/**
 * Rank mechanics (ADR 0007). `rank` is a single relative order, core-owned
 * (never exposed), dense over the **rankable set** — a task with
 * `lifecycle ∈ {todo, in_progress}` and `hold = none`, scoped per project.
 * Encoded as INTEGER-with-gaps: append is `MAX(rank) + STEP`; an insert between
 * neighbours takes their midpoint; when neighbours are adjacent `reindexRanks`
 * re-spreads the set (the rare O(n), amortized off the hot path, with an
 * on-the-spot reindex as the safety valve so correctness never waits).
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

async function maxRank(tx: Tx, projectId: number): Promise<number | null> {
  const row = await tx
    .selectFrom('node')
    .select((eb) => eb.fn.max('rank').as('value'))
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null)
    .executeTakeFirst();
  return row?.value ?? null;
}

async function minRank(tx: Tx, projectId: number): Promise<number | null> {
  const row = await tx
    .selectFrom('node')
    .select((eb) => eb.fn.min('rank').as('value'))
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** The rank immediately below (largest `< pivot`) or above (smallest `> pivot`) a pivot, within a project. */
async function adjacentRank(
  tx: Tx,
  projectId: number,
  pivot: number,
  direction: 'below' | 'above',
): Promise<number | null> {
  const q = tx
    .selectFrom('node')
    .select('rank')
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null);
  const row =
    direction === 'below'
      ? await q.where('rank', '<', pivot).orderBy('rank', 'desc').limit(1).executeTakeFirst()
      : await q.where('rank', '>', pivot).orderBy('rank', 'asc').limit(1).executeTakeFirst();
  return row?.rank ?? null;
}

/** The next append-to-bottom rank for a project's rankable set: `MAX(rank) + STEP`, or `STEP` if empty. */
export async function appendRank(tx: Tx, projectId: number): Promise<number> {
  return ((await maxRank(tx, projectId)) ?? 0) + RANK_STEP;
}

/**
 * Re-spread a project's rankable set to clean multiples of `RANK_STEP`,
 * preserving order (rank asc, `seq` asc as a stable tiebreak). Idempotent — a
 * second run is a no-op. The deliberate O(n), bounded to one project's
 * actionable tasks; rank is invisible to consumers, so this does not touch
 * `updated_at`.
 */
export async function reindexRanks(tx: Tx, projectId: number): Promise<void> {
  const ranked = await tx
    .selectFrom('node')
    .select('id')
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null)
    .orderBy('rank', 'asc')
    .orderBy('seq', 'asc')
    .execute();
  let next = RANK_STEP;
  for (const row of ranked) {
    await tx.updateTable('node').set({ rank: next }).where('id', '=', row.id).execute();
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
  tx: Tx,
  projectId: number,
  taskId: number,
  position: RankPosition,
  refId: number | null,
): Promise<void> {
  const rank = await computeTargetRank(tx, projectId, taskId, position, refId, true);
  await tx.updateTable('node').set({ rank }).where('id', '=', taskId).execute();
}

async function rankOf(tx: Tx, taskId: number): Promise<number> {
  const row = await tx
    .selectFrom('node')
    .select('rank')
    .where('id', '=', taskId)
    .executeTakeFirst();
  if (row?.rank == null) {
    throw validation(`task ${String(taskId)} is not in the rankable set`);
  }
  return row.rank;
}

async function computeTargetRank(
  tx: Tx,
  projectId: number,
  taskId: number,
  position: RankPosition,
  refId: number | null,
  allowReindex: boolean,
): Promise<number> {
  if (position === 'bottom') {
    return ((await maxRank(tx, projectId)) ?? 0) + RANK_STEP;
  }
  if (position === 'top') {
    const min = await minRank(tx, projectId);
    return min === null ? RANK_STEP : min - RANK_STEP;
  }

  // before / after — relative to a reference task
  if (refId === null) {
    throw validation(`'${position}' requires a reference task`);
  }
  if (refId === taskId) {
    throw validation('cannot position a task relative to itself');
  }
  const refRank = await rankOf(tx, refId);
  const neighbor = await adjacentRank(
    tx,
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
  await reindexRanks(tx, projectId);
  return computeTargetRank(tx, projectId, taskId, position, refId, false);
}
