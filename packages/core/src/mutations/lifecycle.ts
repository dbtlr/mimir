import { conflict, validation } from '../errors';
import type { Node } from '../model';
import { appendRank } from '../rank';
import type { NodePatch, Store } from '../store';
import { now } from '../time';
import { logTransition, reloadNode, requireTask, stamp } from './common';
import { applyHandlePatch, clearHandles, handlesOf, validateAssignment } from './handles';
import type { HandleFields, MainHandleFields } from './handles';

/**
 * Lifecycle verbs run their guard, patch, handle echo, and timestamp in one
 * transaction. Queue reserves a todo task for a run; start claims todo work or
 * preserves the main conversation while attaching an optional whole-task worker. Both preserve rank.
 * Unqueue clears the reservation handles and preserves rank. Terminal verbs
 * clear handles and rank; submit/return retain handles through human review.
 * Hold is left untouched on terminal transitions, preserving its history.
 */

/** The exact task state a caller used to decide whether ambient main identity could be filled. */
export type StartExpectation = Pick<Node, 'lifecycle' | 'harness' | 'session'>;

/** Begin work, preserving main identity and replacing queued execution context. */
export async function startTask(
  store: Store,
  id: string,
  handles: HandleFields = {},
  expectation?: StartExpectation,
): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (
      expectation !== undefined &&
      (task.lifecycle !== expectation.lifecycle ||
        task.harness !== expectation.harness ||
        task.session !== expectation.session)
    ) {
      throw conflict(
        'task ownership changed before start',
        'read the task again before deciding its main assignment',
      );
    }
    if (task.lifecycle !== 'todo' && task.lifecycle !== 'queued') {
      throw validation(`only a todo or queued task can be started (is ${String(task.lifecycle)})`);
    }
    const patch: NodePatch = { lifecycle: 'in_progress' };
    if (task.lifecycle === 'queued') {
      patch.branch = null;
      patch.host = null;
    }
    applyHandlePatch(patch, handles);
    for (const key of ['harness', 'session'] as const) {
      if (task[key] !== null && patch[key] !== undefined && patch[key] !== task[key]) {
        throw validation(
          `start preserves the main ${key}`,
          'use workerHarness/workerSession (--worker-harness/--worker-session) for a whole-task worker, or update for explicit main takeover',
        );
      }
    }
    validateAssignment(patch, task);
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: task.lifecycle,
      handles: handlesOf(await reloadNode(w, id)),
      kind: 'lifecycle',
      node_id: id,
      to_value: 'in_progress',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

/** Reserve a todo task for its main conversation or workflow. */
export async function queueTask(
  store: Store,
  id: string,
  handles: MainHandleFields = {},
): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'todo') {
      throw validation(`only a todo task can be queued (is ${String(task.lifecycle)})`);
    }
    if (task.hold !== 'none') {
      throw validation(`cannot queue a ${String(task.hold)} task`);
    }
    const patch: NodePatch = { lifecycle: 'queued' };
    clearHandles(patch, task);
    applyHandlePatch(patch, handles);
    if (typeof patch.session !== 'string' || patch.session.trim() === '') {
      throw validation('queue requires a nonblank session');
    }
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: 'todo',
      handles: handlesOf(await reloadNode(w, id)),
      kind: 'lifecycle',
      node_id: id,
      to_value: 'queued',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

/** Cancel a reservation, retaining its rank and recording the cleared run handles. */
export async function unqueueTask(store: Store, id: string, reason?: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'queued') {
      throw validation(`only a queued task can be unqueued (is ${String(task.lifecycle)})`);
    }
    if (reason === undefined || reason.trim() === '') {
      throw validation('unqueue requires a nonblank reason');
    }
    const patch: NodePatch = { lifecycle: 'todo' };
    const handles = clearHandles(patch, task);
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: 'queued',
      handles,
      kind: 'lifecycle',
      node_id: id,
      reason,
      to_value: 'todo',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function submitTask(store: Store, id: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'in_progress') {
      throw validation(
        `only an in_progress task can be submitted for review (is ${String(task.lifecycle)})`,
      );
    }
    await w.updateNode(id, { lifecycle: 'under_review', rank: null });
    await logTransition(w, {
      from_value: 'in_progress',
      kind: 'lifecycle',
      node_id: id,
      to_value: 'under_review',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function returnTask(store: Store, id: string, reason?: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'under_review') {
      throw validation(`only an under_review task can be returned (is ${String(task.lifecycle)})`);
    }
    // re-enter the rankable set at the bottom (a return is a natural re-triage point)
    const rank = await appendRank(w, task.project_id);
    await w.updateNode(id, { lifecycle: 'in_progress', rank });
    await logTransition(w, {
      from_value: 'under_review',
      kind: 'lifecycle',
      node_id: id,
      reason: reason ?? null,
      to_value: 'in_progress',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function completeTask(store: Store, id: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    const patch: NodePatch = { completed_at: now(), lifecycle: 'done', rank: null };
    const handles = clearHandles(patch, task);
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: task.lifecycle,
      handles,
      kind: 'lifecycle',
      node_id: id,
      to_value: 'done',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function abandonTask(store: Store, id: string, reason?: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    const patch: NodePatch = { lifecycle: 'abandoned', rank: null };
    const handles = clearHandles(patch, task);
    await w.updateNode(id, patch);
    await logTransition(w, {
      from_value: task.lifecycle,
      handles,
      kind: 'lifecycle',
      node_id: id,
      reason: reason ?? null,
      to_value: 'abandoned',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

/**
 * Reopen a terminal task (MMR-104) — the deliberate correction path. `done` or
 * `abandoned` → `in_progress`, re-entering the rankable set at the bottom (a
 * reopen is a natural re-triage point, like `return`) and clearing
 * `completed_at`. The reason rides the transition-log row. Append-only: the
 * original done/abandon transition is preserved, so the full trail survives.
 * `done` stays a trusted terminal — prevention of premature-done is the
 * `submit`/`under_review` gate, not a casual reopen.
 */
export async function reopenTask(store: Store, id: string, reason?: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'done' && task.lifecycle !== 'abandoned') {
      throw validation(
        `only a done or abandoned task can be reopened (is ${String(task.lifecycle)})`,
      );
    }
    // re-enter the rankable set at the bottom (a reopen is a natural re-triage point)
    const rank = await appendRank(w, task.project_id);
    await w.updateNode(id, { completed_at: null, lifecycle: 'in_progress', rank });
    await logTransition(w, {
      from_value: task.lifecycle,
      kind: 'lifecycle',
      node_id: id,
      reason: reason ?? null,
      to_value: 'in_progress',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}
