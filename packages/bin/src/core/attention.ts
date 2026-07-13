import type { AttentionState, Lane, StatusWord } from '@mimir/contract';

import type { DerivationSet } from './derive';
import { nodeStatusWord } from './derive';
import type { Project } from './model';
import { isStale } from './predicates';
import type { StaleOptions } from './predicates';

/**
 * The project attention-state (MMR-101) — a derived facet that lets the overview
 * page (MMR-102) order projects by "what deserves the operator's attention,"
 * not alphabetically. Lives in core so every transport consumes it and the UI
 * stays a pure renderer. Pure over one derivation snapshot (ADR 0016 Phase 0);
 * the overview derives every project from the same set, so the per-project
 * leaf scans share one memo.
 */

/**
 * The lanes in highest-wins order — index 0 is the strongest pull on the
 * operator. A leaf task's Status word maps to the lane whose membership it
 * satisfies; `at_rest` is the floor (parked / terminal / nothing actionable).
 */
const LANES: readonly Lane[] = ['awaiting_you', 'live', 'needs_unsticking', 'at_rest'];
const AT_REST = LANES.length - 1;

/** A leaf task's Status word → its lane index (lower = higher attention). */
function laneIndex(word: StatusWord): number {
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
 * - **lane** — the highest lane any leaf qualifies for (lowest index wins).
 * - **lastActivity** — `max(updated_at)` across the leaves (intra-lane recency
 *   for MMR-102); the project's own `updated_at` when it has no tasks.
 * - **stale** — the `going cold` modifier: ≥1 leaf is {@link isStale}. Always
 *   rides a higher lane (stale only fires on live/blocked/under_review words).
 */
export function attentionOf(
  set: DerivationSet,
  project: Project,
  options: StaleOptions = {},
): AttentionState {
  const tasks = (set.nodesByProject.get(project.key) ?? []).filter((n) => n.type === 'task');

  let best = AT_REST;
  let stale = false;
  let lastActivity: string | null = null;
  for (const task of tasks) {
    best = Math.min(best, laneIndex(nodeStatusWord(set, task)));
    if (!stale && isStale(set, task, options)) {
      stale = true;
    }
    if (lastActivity === null || Date.parse(task.updated_at) > Date.parse(lastActivity)) {
      lastActivity = task.updated_at;
    }
  }

  return {
    lane: LANES[best] ?? 'at_rest',
    lastActivity: lastActivity ?? project.updated_at,
    stale,
  };
}
