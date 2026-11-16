import type { ChecklistItem, ChecklistRecord } from '@mimir/contract';
import type { Kysely } from 'kysely';

import type { ChecklistSettle, ChecklistStore, NewChecklistItem } from '../checklist/store';
import { invariant } from '../errors';
import { inLists, insertBatched } from './batch';
import type { StoreDialect } from './dialect';
import type { DB, Executor } from './schema';

/** The columns of an item as every read returns them, in the public field order. */
const ITEM_COLUMNS = ['number', 'content', 'state', 'reason', 'created_at', 'settled_at'] as const;

/** A task's items in number order. */
export function loadChecklist(ex: Executor, task: string): Promise<ChecklistItem[]> {
  return ex
    .selectFrom('checklist_item')
    .select(ITEM_COLUMNS)
    .where('node_id', '=', task)
    .orderBy('number')
    .execute();
}

/**
 * Add an open item numbered one past the task's highest. Items are never
 * deleted, so the highest number is the count. The caller has stamped the task
 * row first, which serializes concurrent adds on it.
 */
export async function insertChecklistItem(
  ex: Executor,
  row: NewChecklistItem,
): Promise<ChecklistItem> {
  const highest = await ex
    .selectFrom('checklist_item')
    .select((eb) => eb.fn.max<number | null>('number').as('highest'))
    .where('node_id', '=', row.task)
    .executeTakeFirst();
  const number = (highest?.highest ?? 0) + 1;
  if (number > 2147483647) {
    throw invariant(`${row.task} has used every item number`);
  }
  const item: ChecklistItem = {
    content: row.content,
    created_at: row.created_at,
    number,
    reason: null,
    settled_at: null,
    state: 'open',
  };
  await ex
    .insertInto('checklist_item')
    .values({ ...item, node_id: row.task })
    .execute();
  return item;
}

/** Settle one open item; the caller has already checked its state in this transaction. */
export async function settleChecklistItem(
  ex: Executor,
  task: string,
  number: number,
  settle: ChecklistSettle,
): Promise<void> {
  await ex
    .updateTable('checklist_item')
    .set(settle)
    .where('node_id', '=', task)
    .where('number', '=', number)
    .execute();
}

/** Several tasks' items, read in as few `IN` lists as the dialect's parameter limit allows. */
async function loadChecklists(
  db: Kysely<DB>,
  dialect: StoreDialect,
  tasks: readonly string[],
): Promise<Map<string, ChecklistItem[]>> {
  const byTask = new Map<string, ChecklistItem[]>(tasks.map((task) => [task, []]));
  for (const chunk of inLists([...new Set(tasks)], dialect.maxParameters)) {
    const rows = await db
      .selectFrom('checklist_item')
      .select(['node_id', ...ITEM_COLUMNS])
      .where('node_id', 'in', chunk)
      .orderBy('node_id')
      .orderBy('number')
      .execute();
    for (const { node_id, ...item } of rows) {
      byTask.get(node_id)?.push(item);
    }
  }
  return byTask;
}

export function createSqlChecklistStore(db: Kysely<DB>, dialect: StoreDialect): ChecklistStore {
  return {
    forTask: (id) => loadChecklist(db, id),
    forTasks: (ids) => loadChecklists(db, dialect, ids),
  };
}

/** Every item with its task, in project-key, then task-sequence, then item-number order. */
export async function exportChecklist(ex: Executor): Promise<ChecklistRecord[]> {
  const rows = await ex
    .selectFrom('checklist_item')
    .leftJoin('node', 'node.id', 'checklist_item.node_id')
    .select([
      'checklist_item.node_id as task',
      'checklist_item.number',
      'checklist_item.content',
      'checklist_item.state',
      'checklist_item.reason',
      'checklist_item.created_at',
      'checklist_item.settled_at',
    ])
    .orderBy('node.project_key')
    .orderBy('node.seq')
    .orderBy('checklist_item.number')
    .execute();
  return rows;
}

/** Write imported items, one statement per chunk (MMR-380's batching rule). */
export async function insertExportedChecklist(
  ex: Executor,
  dialect: StoreDialect,
  items: readonly ChecklistRecord[],
): Promise<void> {
  const rows = items.map(({ task, ...item }) => ({ ...item, node_id: task }));
  await insertBatched(rows, dialect.maxParameters, (chunk) =>
    ex.insertInto('checklist_item').values(chunk).execute(),
  );
}
