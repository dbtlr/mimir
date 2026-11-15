import { CHECKLIST_ITEM_STATE_VALUES } from '@mimir/contract';
import type { ChecklistRecord } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

/**
 * The rules the checklist verbs keep, checked on stored or imported rows
 * (ADR 0044). Import and doctor share it, so a row one refuses the other
 * reports. The item is named `TASK item N`.
 */
export function checklistFaults(
  items: readonly ChecklistRecord[],
  nodes: ReadonlyMap<string, { type: string }>,
): { id: string; message: string }[] {
  const faults: { id: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = `${item.task} item ${String(item.number)}`;
    const fail = (message: string): void => {
      faults.push({ id, message });
    };
    const node = nodes.get(item.task);
    if (node === undefined) {
      fail('names a missing task');
    } else if (node.type !== 'task') {
      fail(`names ${node.type === 'initiative' ? 'an' : 'a'} ${node.type}, not a task`);
    }
    if (!Number.isInteger(item.number) || item.number < 1) {
      fail('number must be a positive integer');
    }
    const key = `${item.task}|${String(item.number)}`;
    if (seen.has(key)) {
      fail('number is used twice on its task');
    }
    seen.add(key);
    if (item.content.trim() === '') {
      fail('content is blank');
    }
    // A stored row is untrusted: read the state as the text it is.
    const state: string = item.state;
    if (!isMember(state, CHECKLIST_ITEM_STATE_VALUES)) {
      fail('state is outside open, checked, and dropped');
      continue;
    }
    if (item.state === 'dropped' && (item.reason === null || item.reason.trim() === '')) {
      fail('is dropped without a reason');
    }
    if (item.state !== 'dropped' && item.reason !== null) {
      fail(`is ${item.state} but carries a reason`);
    }
    if (item.state === 'open' && item.settled_at !== null) {
      fail('is open but has a settled_at');
    }
    if (item.state !== 'open' && item.settled_at === null) {
      fail(`is ${item.state} without a settled_at`);
    }
    if (item.settled_at !== null && item.settled_at < item.created_at) {
      fail('settled_at is before its created_at');
    }
  }
  return faults;
}
