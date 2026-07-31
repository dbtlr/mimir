import type { Hold } from '@mimir/contract';

import { validation } from '../errors';
import type { Node } from '../model';
import { appendRank, isRankable } from '../rank';
import type { NodePatch, Store } from '../store';
import { clearHandles, logTransition, reloadNode, requireTask, stamp } from './common';

/**
 * Hold verbs (ADR 0001/0007). The hold overlay is orthogonal to lifecycle: a
 * task keeps its lifecycle position while held. Entering a hold (`park`/`block`)
 * leaves the rankable set → clears `rank`; releasing it (`unpark`/`unblock`)
 * re-enters → appends to the bottom (no remembered position; a re-entry is a
 * natural re-triage point) — but only if the underlying lifecycle is rankable.
 * A held `under_review` task stays non-rankable on release (it's not actionable
 * until the human verdict lands), so it gets no rank back.
 *
 * Entering a hold also CLEARS the resume handles (ADR 0026 Decision 3, MMR-320):
 * held work is not in flight, and a stale host/session pointer is worse than an
 * absent one. Releasing restores nothing — a resuming agent re-states them with
 * `update`, which is also how a takeover overwrites them.
 */

function assertHoldable(task: Node): void {
  if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
    throw validation(`cannot hold a ${task.lifecycle} task`);
  }
}

async function enterHold(
  store: Store,
  id: string,
  to: Exclude<Hold, 'none'>,
  reason?: string,
): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    assertHoldable(task);
    if (task.hold !== 'none') {
      throw validation(`task is already ${task.hold}`);
    }
    const patch: NodePatch = { hold: to, hold_reason: reason ?? null, rank: null };
    const handles = clearHandles(patch, task);
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: 'none',
      handles,
      kind: 'hold',
      node_id: id,
      reason: reason ?? null,
      to_value: to,
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

async function releaseHold(store: Store, id: string, from: Exclude<Hold, 'none'>): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.hold !== from) {
      throw validation(`task is not ${from} (is ${String(task.hold)})`);
    }
    // Re-enter the rankable set at the bottom — but only if the lifecycle is
    // rankable once un-held (todo/in_progress). A held `under_review` task
    // stays non-rankable on release (not actionable until the verdict lands).
    const rank = isRankable(task.lifecycle, 'none') ? await appendRank(w, task.project_id) : null;
    await w.updateNode(id, { hold: 'none', hold_reason: null, rank });
    await logTransition(w, { from_value: from, kind: 'hold', node_id: id, to_value: 'none' });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export const parkTask = (store: Store, id: string, reason?: string): Promise<Node> =>
  enterHold(store, id, 'parked', reason);

export const unparkTask = (store: Store, id: string): Promise<Node> =>
  releaseHold(store, id, 'parked');

export const blockTask = (store: Store, id: string, reason?: string): Promise<Node> =>
  enterHold(store, id, 'blocked', reason);

export const unblockTask = (store: Store, id: string): Promise<Node> =>
  releaseHold(store, id, 'blocked');
