import type { DeliveryLifecycle, Lifecycle } from '@mimir/contract';

import { notFound, validation } from '../errors';
import type { Node } from '../model';
import { clearToTodo } from '../mutations/handles';
import type { NodePatch, StoreWriter } from '../store';
import { now } from '../time';
import { isTerminalDelivery } from './store';

/**
 * Delivery membership (ADR 0042): the one member predicate, the one join
 * rule, the one rule for which stored references are valid, and the writes
 * that change membership. Every write here runs through the writer, inside the
 * transaction it guards.
 */

/** The lifecycles that end a task: a task in one is not live, so it is a member of nothing. */
export const ENDED_TASK_LIFECYCLES = ['done', 'abandoned'] as const satisfies readonly Lifecycle[];

export function isLiveTask(lifecycle: Lifecycle | null | undefined): boolean {
  return !ENDED_TASK_LIFECYCLES.some((ended) => ended === lifecycle);
}

/** A member is a live task whose `delivery` names a non-terminal delivery. */
export function isDeliveryMember(
  task: { delivery?: string | null; lifecycle?: Lifecycle | null },
  delivery: { lifecycle: DeliveryLifecycle } | undefined,
): boolean {
  return (
    task.delivery !== null &&
    task.delivery !== undefined &&
    delivery !== undefined &&
    isLiveTask(task.lifecycle) &&
    !isTerminalDelivery(delivery.lifecycle)
  );
}

/** Only unclaimed work joins: a todo task, any hold, in the phase, and not a member. */
export function canJoin(
  task: Pick<Node, 'type' | 'lifecycle' | 'parent_id'>,
  phase: string,
  member: boolean,
): boolean {
  return task.type === 'task' && task.lifecycle === 'todo' && task.parent_id === phase && !member;
}

/** The delivery facts a reference is judged against. */
export type ReferencedDelivery = {
  key: string;
  lifecycle: DeliveryLifecycle;
  phase: string;
};

/**
 * Why a node's stored `delivery` reference is one no verb produces, or `null`
 * when it is valid. A reference is valid on a member (a live, unqueued task
 * in the delivery's phase naming a non-terminal delivery) and on a task that
 * `land` completed (done, naming a landed delivery, wherever it has moved
 * since). Import refuses and doctor reports every other state.
 */
export function deliveryReferenceFault(
  node: Pick<Node, 'type' | 'lifecycle' | 'parent_id' | 'project_id'>,
  delivery: ReferencedDelivery | undefined,
): string | null {
  if (node.type !== 'task') {
    return 'is set, but only tasks carry delivery';
  }
  if (delivery === undefined) {
    return 'names a missing delivery';
  }
  if (delivery.key !== node.project_id) {
    return 'names a delivery in another project';
  }
  if (node.lifecycle === 'done') {
    return delivery.lifecycle === 'landed'
      ? null
      : 'is on a done task, so its delivery must have landed';
  }
  if (node.lifecycle === 'abandoned') {
    return 'is on an abandoned task, which names no delivery';
  }
  if (node.lifecycle === 'queued') {
    return 'is on a queued task, which cannot be a member';
  }
  if (isTerminalDelivery(delivery.lifecycle)) {
    return 'is on a live task, so its delivery must be non-terminal';
  }
  return node.parent_id === delivery.phase
    ? null
    : "is on a member, so the task's parent must be the delivery's phase";
}

/** The delivery `task` is a member of, read inside the transaction it guards. */
export async function memberDelivery(w: StoreWriter, task: Node): Promise<string | null> {
  if (task.delivery === null) {
    return null;
  }
  return isDeliveryMember(task, await w.loadDelivery(task.delivery)) ? task.delivery : null;
}

/** Whether `task` may join a delivery of `phase` now. */
export async function joinable(w: StoreWriter, task: Node, phase: string): Promise<boolean> {
  return canJoin(task, phase, (await memberDelivery(w, task)) !== null);
}

/** Write one membership event: the task's reference, its stamp, and the delivery's log row. */
async function recordMembership(
  w: StoreWriter,
  task: string,
  reference: string | null,
  event: { delivery: string; to: 'joined' | 'left' | 'released' | 'abandoned' },
): Promise<void> {
  await w.updateNode(task, { delivery: reference, updated_at: now() });
  await w.appendDeliveryMember(event.delivery, task, event.to);
}

/** Join `task` to `delivery`, refusing work that cannot join. */
export async function joinDelivery(
  w: StoreWriter,
  task: Node,
  delivery: { id: string; phase: string },
): Promise<void> {
  if (!(await joinable(w, task, delivery.phase))) {
    throw validation(
      `${task.id} cannot join — only an unqueued todo task in the delivery's phase that is not already a member can join`,
    );
  }
  await recordMembership(w, task.id, delivery.id, { delivery: delivery.id, to: 'joined' });
}

/** Apply `update --delivery`: join `target`, or leave with `null`. */
export async function changeMembership(
  w: StoreWriter,
  task: Node,
  target: string | null,
): Promise<void> {
  if (task.type !== 'task') {
    throw validation('delivery applies only to tasks');
  }
  if (target !== null) {
    const delivery = await w.loadDelivery(target);
    if (delivery === undefined) {
      throw notFound(`${target} doesn't exist`);
    }
    if (isTerminalDelivery(delivery.lifecycle)) {
      throw validation(`${target} is terminal`);
    }
    await joinDelivery(w, task, { id: target, phase: delivery.phase });
    return;
  }
  const current = await memberDelivery(w, task);
  if (current === null) {
    throw validation(`${task.id} is not a member`);
  }
  if (task.lifecycle === 'staged') {
    throw validation('a staged member cannot leave', `return ${task.id} first`);
  }
  await recordMembership(w, task.id, null, { delivery: current, to: 'left' });
}

/** Task `abandon` ends membership, logged as `abandoned`; a staged member refuses. */
export async function leaveOnAbandon(w: StoreWriter, task: Node): Promise<void> {
  const current = await memberDelivery(w, task);
  if (current === null) {
    return;
  }
  if (task.lifecycle === 'staged') {
    throw validation('a staged member cannot be abandoned', `return ${task.id} first`);
  }
  await recordMembership(w, task.id, null, { delivery: current, to: 'abandoned' });
}

/**
 * `abandon` on a delivery releases one live member (ADR 0042). A member past
 * `todo` returns to it, clearing and recording its handles with the delivery's
 * reason, and gets an appended rank only when it is unheld and has none; a
 * `todo` member changes only its membership. Either way the task keeps its
 * hold, hold reason, and block owner, and the delivery logs `released`.
 * `nextRank` hands out the release's appended ranks (one ranked-set read per
 * abandon, not per member).
 */
export async function releaseMember(
  w: StoreWriter,
  task: Node,
  delivery: string,
  reason: string | null,
  nextRank: () => Promise<number>,
): Promise<void> {
  if (task.lifecycle !== 'todo') {
    const extra: NodePatch = {};
    if (task.hold === 'none' && task.rank === null) {
      extra.rank = await nextRank();
    }
    await clearToTodo(w, task, reason, extra);
  }
  await recordMembership(w, task.id, null, { delivery, to: 'released' });
}

/** A member has one reservation; queue and move require an explicit leave. */
export async function refuseMember(w: StoreWriter, task: Node): Promise<void> {
  if (await memberDelivery(w, task)) {
    throw validation(`${task.id} is a delivery member`, `update ${task.id} --delivery none first`);
  }
}

/** A member finishes when its delivery lands, so `done` refuses it. */
export async function refuseMemberDone(w: StoreWriter, task: Node): Promise<void> {
  if (await memberDelivery(w, task)) {
    throw validation(
      `${task.id} is a delivery member — a member is finished when its delivery lands`,
      `land ${task.delivery ?? 'KEY-dN'}, or to finish it alone, leave first: update ${task.id} --delivery none`,
    );
  }
}
