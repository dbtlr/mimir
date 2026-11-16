import type { DeliveryFollowUpRecord } from '@mimir/contract';

import { isCanonicalInstant } from '../time';

/** Shared transfer and doctor checks over raw links, including archived records. */
export function followUpFaults(
  rows: readonly DeliveryFollowUpRecord[],
  deliveries: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, { type: string; project_id: string }>,
  seeds: ReadonlySet<string>,
): { id: string; message: string }[] {
  const faults: { id: string; message: string }[] = [];
  const standing = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const id = `${row.delivery} follow-up ${String(index + 1)}`;
    const fail = (message: string) => faults.push({ id, message });
    const project = deliveries.get(row.delivery);
    if (project === undefined) {
      fail('delivery is missing');
    }
    if ((row.task === null) === (row.seed === null)) {
      fail('exactly one of task and seed is required');
    }
    if (row.task !== null) {
      const task = nodes.get(row.task);
      if (!task) {
        fail('task is missing');
      } else if (task.type !== 'task') {
        fail('node is not a task');
      } else if (task.project_id !== project) {
        fail('task is in another project');
      }
    }
    if (row.seed !== null && !seeds.has(row.seed)) {
      fail('seed is missing');
    }
    const key = `${row.delivery}/${row.task ?? row.seed ?? ''}`;
    if (row.unlinked_at === null) {
      if (standing.has(key)) {
        fail('duplicate standing link');
      }
      standing.add(key);
    }
    if (!isCanonicalInstant(row.linked_at)) {
      fail('linked_at is not a canonical UTC instant');
    }
    if (row.unlinked_at !== null) {
      if (!isCanonicalInstant(row.unlinked_at)) {
        fail('unlinked_at is not a canonical UTC instant');
      } else if (row.unlinked_at < row.linked_at) {
        fail('unlinked_at is earlier than linked_at');
      }
    }
  }
  return faults;
}
