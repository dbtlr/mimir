import type { AttentionBand, AttentionState, StatusWord } from '@mimir/contract';

import type { Project } from '../db/schema';
import type { Db, Tx } from './context';
import { nodeStatusWord } from './derive';
import { isStale } from './predicates';
import type { StaleOptions } from './predicates';

/**
 * The project attention-state (MMR-101) — a derived facet that lets the overview
 * page (MMR-102) order projects by "what deserves the operator's attention,"
 * not alphabetically. Lives in core so every transport consumes it and the UI
 * stays a pure renderer.
 */

type Executor = Db | Tx;

/**
 * The bands in highest-wins order — index 0 is the strongest pull on the
 * operator. A leaf task's Status word maps to the band whose membership it
 * satisfies; `at_rest` is the floor (parked / terminal / nothing actionable).
 */
const BANDS: readonly AttentionBand[] = ['awaiting_you', 'live', 'needs_unsticking', 'at_rest'];
const AT_REST = BANDS.length - 1;

/** A leaf task's Status word → its band index (lower = higher attention). */
function bandIndex(word: StatusWord): number {
  switch (word) {
    case 'under_review': {
      return 0;
    } // awaiting_you — only your review clears it
    case 'in_progress':
    case 'ready': {
      return 1;
    } // live — work in motion
    case 'blocked':
    case 'awaiting': {
      return 2;
    } // needs_unsticking — stuck, often on something external
    default: {
      return AT_REST;
    } // parked / done / abandoned / new
  }
}

/**
 * Derive a project's attention-state from a single scan of its leaf tasks
 * (containers roll up from leaves, so the scan is `type = "task"`):
 *
 * - **band** — the highest band any leaf qualifies for (lowest index wins).
 * - **lastActivity** — `max(updated_at)` across the leaves (intra-band recency
 *   for MMR-102); the project's own `updated_at` when it has no tasks.
 * - **stale** — the `going cold` modifier: ≥1 leaf is {@link isStale}. Always
 *   rides a higher band (stale only fires on live/blocked/under_review words).
 */
export async function attentionOf(
  tx: Executor,
  project: Project,
  options: StaleOptions = {},
): Promise<AttentionState> {
  const tasks = await tx
    .selectFrom('node')
    .selectAll()
    .where('project_id', '=', project.id)
    .where('type', '=', 'task')
    .execute();

  let best = AT_REST;
  let stale = false;
  let lastActivity: string | null = null;
  for (const task of tasks) {
    best = Math.min(best, bandIndex(await nodeStatusWord(tx, task)));
    if (!stale && (await isStale(tx, task, options))) {
      stale = true;
    }
    if (lastActivity === null || Date.parse(task.updated_at) > Date.parse(lastActivity)) {
      lastActivity = task.updated_at;
    }
  }

  return {
    band: BANDS[best] ?? 'at_rest',
    lastActivity: lastActivity ?? project.updated_at,
    stale,
  };
}
