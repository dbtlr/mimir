import { validation } from '../errors';
import type { Node } from '../model';
import { appendRank } from '../rank';
import type { Store } from '../store';
import { now } from '../time';
import { logTransition, reloadNode, requireTask, stamp } from './common';

/**
 * Lifecycle verbs (ADR 0001/0003/0007). `start` keeps the task in the rankable
 * set (todo→in_progress, un-held); `done`/`abandon` are terminal and leave it,
 * clearing `rank`. `done` stamps `completed_at`; `abandon` carries its reason on
 * the transition-log row. Hold is left untouched on terminal transitions — the
 * Status word projects to `done`/`abandoned` regardless, and the history records
 * what the hold was.
 *
 * `submit`/`return` are the optional ship-readiness gate (MMR-84): `submit`
 * moves `in_progress → under_review` (the doer asserts it's shippable) and
 * `return` moves it back to `in_progress` (the reviewer requests changes, the
 * reason riding the log row). `under_review` is non-rankable (not agent-
 * actionable — the ball is in the human's court), so `submit` clears `rank` and
 * `return` re-enters at the bottom, exactly like the hold enter/release pattern.
 * Approval is plain `complete_task` (the log's `from=under_review` marks it).
 */

export async function startTask(store: Store, id: number): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle !== 'todo') {
      throw validation(`only a todo task can be started (is ${String(task.lifecycle)})`);
    }
    await w.updateNode(id, { lifecycle: 'in_progress' });
    await logTransition(w, {
      from_value: 'todo',
      kind: 'lifecycle',
      node_id: id,
      to_value: 'in_progress',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function submitTask(store: Store, id: number): Promise<Node> {
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

export async function returnTask(store: Store, id: number, reason?: string): Promise<Node> {
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

export async function completeTask(store: Store, id: number): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await w.updateNode(id, { completed_at: now(), lifecycle: 'done', rank: null });
    await logTransition(w, {
      from_value: task.lifecycle,
      kind: 'lifecycle',
      node_id: id,
      to_value: 'done',
    });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function abandonTask(store: Store, id: number, reason?: string): Promise<Node> {
  return store.transact(async (w) => {
    const task = await requireTask(w, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await w.updateNode(id, { lifecycle: 'abandoned', rank: null });
    await logTransition(w, {
      from_value: task.lifecycle,
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
export async function reopenTask(store: Store, id: number, reason?: string): Promise<Node> {
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
