import type { DeliveryLifecycle, Lifecycle } from '@mimir/contract';

import { notFound, validation } from '../errors';
import type { Node } from '../model';
import type { StoreWriter } from '../store';
import { now } from '../time';
import { isTerminalDelivery } from './store';

/**
 * Delivery membership (ADR 0042): the one member predicate, the one join
 * rule, and the writes
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
  event: { delivery: string; to: 'joined' | 'left' | 'abandoned' },
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
      `to finish it alone, leave first: update ${task.id} --delivery none`,
    );
  }
}
