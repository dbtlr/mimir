import type { Verdicts } from '@mimir/contract';

import type { DerivationSet } from './derive';
import { hasUnsettledPrereq, isNodeSettled, isTerminalWord, nodeStatusWord } from './derive';
import type { Node } from './model';
import { now } from './time';

/**
 * The derived predicate vocabulary (design spec §4, glossary). Each is computed
 * live because it depends on dependencies or ancestors and flips silently when
 * *those* change — storing it would reintroduce the sync surface Mimir exists
 * to remove. Pure over one {@link DerivationSet} snapshot (ADR 0016 Phase 0).
 */

/** `ready` — the headline: a todo, un-held task with every prerequisite settled. */
export function isReady(set: DerivationSet, task: Node): boolean {
  if (task.type !== 'task' || task.lifecycle !== 'todo' || task.hold !== 'none') {
    return false;
  }
  return !hasUnsettledPrereq(set, task.id);
}

/** `awaiting` — `ready`'s involuntary sibling: todo + un-held but with ≥1 unsettled prerequisite. */
export function isAwaiting(set: DerivationSet, task: Node): boolean {
  if (task.type !== 'task' || task.lifecycle !== 'todo' || task.hold !== 'none') {
    return false;
  }
  return hasUnsettledPrereq(set, task.id);
}

/** `blocked` — the manual hold overlay (distinct from the derived `awaiting`). */
export function isBlocked(task: Node): boolean {
  return task.type === 'task' && task.hold === 'blocked';
}

/** `blocking` — this node is a prerequisite of ≥1 still-unsettled dependent. */
export function isBlocking(set: DerivationSet, node: Node): boolean {
  for (const dependentId of set.dependentsByNode.get(node.id) ?? []) {
    const dependent = set.nodeById.get(dependentId);
    if (dependent !== undefined && !isNodeSettled(set, dependent)) {
      return true;
    }
  }
  return false;
}

/** Default `stale` threshold — fixed (the Brief defers per-size refinement). 14 days. */
export const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

export type StaleOptions = {
  /** Reference time (ISO-ms-Z). Defaults to now — injectable for tests. */
  asOf?: string;
  thresholdMs?: number;
};

/**
 * `stale` — a task whose Status word is `in_progress`, `ready`, `blocked`, or
 * `under_review` and whose `updated_at` is older than the threshold (glossary).
 * Mutes `parked` and `awaiting` (auto-clearing / deliberately set aside — don't
 * nag); chases `blocked` (untouched-for-weeks is exactly the nudge) and
 * `under_review` (a submission the human never got to is the same rot).
 */
export function isStale(set: DerivationSet, task: Node, options: StaleOptions = {}): boolean {
  if (task.type !== 'task') {
    return false;
  }
  const word = nodeStatusWord(set, task);
  if (word !== 'in_progress' && word !== 'ready' && word !== 'blocked' && word !== 'under_review') {
    return false;
  }
  const asOf = options.asOf ?? now();
  const thresholdMs = options.thresholdMs ?? STALE_THRESHOLD_MS;
  const ageMs = Date.parse(asOf) - Date.parse(task.updated_at);
  return ageMs > thresholdMs;
}

/**
 * `orphaned` — a non-terminal task stranded under a parent whose *other*
 * children are all terminal (so the parent is effectively closed out around it).
 *
 * The original glossary wording — "parent phase/initiative is done/abandoned" —
 * is unsatisfiable under strict derivation: a non-leaf can never roll up to a
 * terminal word while it still has a live child (this very task). The glossary
 * `orphaned` entry was refined (2026-06-05) to the meaningful sibling of that
 * intent, which this computes: a non-terminal task whose every *other* sibling
 * is terminal (a sole live child is not orphaned).
 */
export function isOrphaned(set: DerivationSet, task: Node): boolean {
  if (task.type !== 'task' || task.parent_id === null) {
    return false;
  }
  if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
    return false;
  }
  const parent = set.nodeById.get(task.parent_id);
  if (parent === undefined || parent.type === 'task') {
    return false;
  }
  // Muted inside an open-ended container (MMR-204): a standing home is *meant* to
  // outlive its filed work, so "every sibling terminal" carries no stranding
  // signal there — it's the normal resting state, not an orphan.
  if (parent.open_ended === true) {
    return false;
  }
  const siblings = (set.childrenByParent.get(parent.id) ?? []).filter((n) => n.id !== task.id);
  if (siblings.length === 0) {
    return false;
  }
  return siblings.every((sibling) => isTerminalWord(nodeStatusWord(set, sibling)));
}

/**
 * All non-status verdicts for one node in one read (the `verdicts` facet —
 * the API record's always-on derivation). Status words carry everything else.
 */
export function verdictsOf(set: DerivationSet, node: Node, options: StaleOptions = {}): Verdicts {
  return {
    blocking: isBlocking(set, node),
    orphaned: isOrphaned(set, node),
    stale: isStale(set, node, options),
  };
}
