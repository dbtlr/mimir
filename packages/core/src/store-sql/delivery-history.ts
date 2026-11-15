import type { DeliveryHistory } from '@mimir/contract';
import type { Transaction } from 'kysely';

import { now } from '../time';
import type { DB } from './schema';

/**
 * The SQL store's one path into `delivery_history`: every lifecycle, hold, and
 * member row a delivery logs goes through {@link appendDeliveryHistory}.
 */

/** Append `history` to delivery `id`, one row at a time: the log's order is its insertion id. */
export async function appendDeliveryHistory(
  tx: Transaction<DB>,
  id: string,
  history: readonly DeliveryHistory[],
): Promise<void> {
  for (const entry of history) {
    await tx
      .insertInto('delivery_history')
      .values({ ...entry, delivery_id: id })
      .execute();
  }
}

/** Log one membership event for `task` and stamp the delivery it changed. */
export async function appendMemberEvent(
  tx: Transaction<DB>,
  delivery: string,
  task: string,
  event: 'joined' | 'left' | 'released' | 'abandoned',
): Promise<void> {
  const at = now();
  await appendDeliveryHistory(tx, delivery, [
    { at, from_value: null, kind: 'member', reason: null, task, to_value: event },
  ]);
  await tx.updateTable('delivery').set({ updated_at: at }).where('id', '=', delivery).execute();
}
