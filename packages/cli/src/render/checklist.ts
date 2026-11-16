import { orderedItem } from '@mimir/contract';
import type { ChecklistItem, ChecklistView } from '@mimir/contract';

import type { Presentation } from './presentation';
import { recordViews } from './views';

/** What an item subcommand returns to the CLI: the checklist, and the item it changed. */
export type ItemEcho = {
  checklist: ChecklistView;
  /** The number of the item the subcommand added, checked, or dropped. */
  changed: number;
  presentation: Presentation;
};

/** The count by state a task's `get` shows: `2 open · 1 checked · 1 dropped`, zero states left out. */
export function itemCounts(items: readonly ChecklistItem[]): string {
  return (['open', 'checked', 'dropped'] as const)
    .map((state) => [state, items.filter((item) => item.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${String(count)} ${state}`)
    .join(' · ');
}

/** One item: its number, state, and content, with a dropped item's reason after it. */
export function itemLine(item: ChecklistItem): string {
  const [first = '', ...rest] = item.content.split('\n');
  const reason = item.reason === null ? '' : ` (${item.reason.replaceAll('\n', ' ')})`;
  return [`${String(item.number)}. ${item.state}: ${first}${reason}`, ...rest].join('\n');
}

/** The `--col items` expansion: one line per item, in number order. */
export function itemsExpanded(items: readonly ChecklistItem[]): string {
  return items.map(itemLine).join('\n');
}

/** The checklist as the ADR prints it: the task first, then each item in field order. */
function checklistJson(checklist: ChecklistView): ChecklistView {
  /* eslint-disable sort-keys -- the public order is the task, then its items. */
  return { task: checklist.task, items: checklist.items.map(orderedItem) };
  /* eslint-enable sort-keys */
}

/** The views of an item subcommand: `ids` the task, `json` the whole checklist, `records` the changed item. */
export const itemEchoViews = recordViews<ItemEcho>({
  ids: (echo) => echo.checklist.task,
  json: (echo) => checklistJson(echo.checklist),
  records: (echo) => {
    const item = echo.checklist.items.find((candidate) => candidate.number === echo.changed);
    return item === undefined
      ? echo.checklist.task
      : `${echo.checklist.task} item ${itemLine(item)}`;
  },
});
