import { validation, notFound } from '../errors';
import type { Node } from '../model';
import type { StoreWriter } from '../store';
import { isTerminalDelivery } from './store';

/** Membership is read through the writer, inside the transaction it guards. */
export async function memberDelivery(w: StoreWriter, task: Node): Promise<string | null> {
  if (task.delivery === null || task.lifecycle === 'done' || task.lifecycle === 'abandoned') {
    return null;
  }
  const delivery = await w.loadDelivery(task.delivery);
  return delivery !== undefined && !isTerminalDelivery(delivery.lifecycle) ? task.delivery : null;
}

/** Only unclaimed todo work in the delivery's phase may join. */
export function assertCanJoin(
  task: Pick<Node, 'id' | 'type' | 'lifecycle' | 'parent_id'>,
  phase: string,
  member: boolean,
): void {
  if (task.type !== 'task' || task.lifecycle !== 'todo' || task.parent_id !== phase || member) {
    throw validation(
      `${task.id} cannot join — only an unqueued todo task in the delivery's phase that is not already a member can join`,
    );
  }
}

/** Apply one membership event and its task reference atomically. */
export async function changeMembership(
  w: StoreWriter,
  task: Node,
  target: string | null,
): Promise<void> {
  if (task.type !== 'task') {
    throw validation('delivery applies only to tasks');
  }
  const current = await memberDelivery(w, task);
  if (target === null) {
    if (current === null) {
      throw validation(`${task.id} is not a member`);
    }
    if (task.lifecycle === 'staged') {
      throw validation('a staged member cannot leave', `return ${task.id} first`);
    }
    await w.updateNode(task.id, { delivery: null });
    await w.appendDeliveryMember(current, task.id, 'left');
    return;
  }
  const delivery = await w.loadDelivery(target);
  if (delivery === undefined) {
    throw notFound(`${target} doesn't exist`);
  }
  if (isTerminalDelivery(delivery.lifecycle)) {
    throw validation(`${target} is terminal`);
  }
  if (delivery.key !== task.project_id) {
    throw validation('a delivery must belong to the task project');
  }
  assertCanJoin(task, delivery.phase, current !== null);
  await w.updateNode(task.id, { delivery: target });
  await w.appendDeliveryMember(target, task.id, 'joined');
}

/** A member has one reservation; queue and move require an explicit leave. */
export async function refuseMember(w: StoreWriter, task: Node): Promise<void> {
  if (await memberDelivery(w, task)) {
    throw validation(`${task.id} is a delivery member`, `update ${task.id} --delivery none first`);
  }
}
