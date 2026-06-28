import type { Node } from '../../db/schema';
import type { Db } from '../context';
import { validation } from '../errors';
import { appendRank } from '../rank';
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

export async function startTask(db: Db, id: number): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle !== 'todo') {
      throw validation(`only a todo task can be started (is ${String(task.lifecycle)})`);
    }
    await tx.updateTable('node').set({ lifecycle: 'in_progress' }).where('id', '=', id).execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: 'todo',
      to_value: 'in_progress',
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function submitTask(db: Db, id: number): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle !== 'in_progress') {
      throw validation(
        `only an in_progress task can be submitted for review (is ${String(task.lifecycle)})`,
      );
    }
    await tx
      .updateTable('node')
      .set({ lifecycle: 'under_review', rank: null })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: 'in_progress',
      to_value: 'under_review',
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function returnTask(db: Db, id: number, reason?: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle !== 'under_review') {
      throw validation(`only an under_review task can be returned (is ${String(task.lifecycle)})`);
    }
    // re-enter the rankable set at the bottom (a return is a natural re-triage point)
    const rank = await appendRank(tx, task.project_id);
    await tx
      .updateTable('node')
      .set({ lifecycle: 'in_progress', rank })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: 'under_review',
      to_value: 'in_progress',
      reason: reason ?? null,
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function completeTask(db: Db, id: number): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await tx
      .updateTable('node')
      .set({ lifecycle: 'done', completed_at: now(), rank: null })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: task.lifecycle,
      to_value: 'done',
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function abandonTask(db: Db, id: number, reason?: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
      throw validation(`task is already ${task.lifecycle}`);
    }
    await tx
      .updateTable('node')
      .set({ lifecycle: 'abandoned', rank: null })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: task.lifecycle,
      to_value: 'abandoned',
      reason: reason ?? null,
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
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
export async function reopenTask(db: Db, id: number, reason?: string): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const task = await requireTask(tx, id);
    if (task.lifecycle !== 'done' && task.lifecycle !== 'abandoned') {
      throw validation(
        `only a done or abandoned task can be reopened (is ${String(task.lifecycle)})`,
      );
    }
    // re-enter the rankable set at the bottom (a reopen is a natural re-triage point)
    const rank = await appendRank(tx, task.project_id);
    await tx
      .updateTable('node')
      .set({ lifecycle: 'in_progress', rank, completed_at: null })
      .where('id', '=', id)
      .execute();
    await logTransition(tx, {
      node_id: id,
      kind: 'lifecycle',
      from_value: task.lifecycle,
      to_value: 'in_progress',
      reason: reason ?? null,
    });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
