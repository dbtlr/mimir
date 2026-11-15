import { decodeChecklist } from '@mimir/contract';
import type { ChecklistItem, EngineChecklist } from '@mimir/contract';

import { conflict, notFound, validation } from '../errors';
import { parseIdentity } from '../ids';
import { requireNode, stamp } from '../mutations/common';
import type { Store, StoreWriter } from '../store';
import { now } from '../time';

/**
 * The checklist verbs (ADR 0044). Each runs in one transaction: it stamps the
 * task's `updated_at` first, which serializes concurrent writers on the task
 * row, then allocates the number or checks the item, writes, and reads the
 * whole checklist back.
 */

/** What a non-task id names, in the words a refusal uses. */
const KIND_NOUN = {
  artifact: 'an artifact',
  decision: 'a decision',
  delivery: 'a delivery',
  project: 'a project',
  seed: 'a seed',
} as const;

/** Refuse an id that is not a task, naming what it is; a non-Mimir id is `not_found`. */
function refuseNonTaskKind(id: string): void {
  const identity = parseIdentity(id);
  if (identity === null) {
    throw notFound(`${id} doesn't exist`);
  }
  if (identity.kind !== 'node') {
    throw validation(
      `${id} is ${KIND_NOUN[identity.kind]}, not a task`,
      'checklist items belong to tasks',
    );
  }
}

async function requireChecklistTask(w: StoreWriter, id: string): Promise<void> {
  refuseNonTaskKind(id);
  const node = await requireNode(w, id);
  if (node.type !== 'task') {
    throw validation(`${id} is a ${node.type}, not a task`, 'checklist items belong to tasks');
  }
}

/** `2026-11-16 10:00`, the UTC minute a settled item names in its refusal. */
function minuteOf(instant: string): string {
  return `${instant.slice(0, 10)} ${instant.slice(11, 16)}`;
}

/** The item `number` of `task`, open: unknown is `not_found`, settled is `conflict`. */
async function openItem(w: StoreWriter, task: string, number: number): Promise<ChecklistItem> {
  const item = (await w.loadChecklist(task)).find((candidate) => candidate.number === number);
  if (item === undefined) {
    throw notFound(`${task} has no item ${String(number)}`);
  }
  if (item.state !== 'open') {
    throw conflict(
      `${task} item ${String(number)} is already ${item.state} (${minuteOf(item.settled_at ?? item.created_at)})`,
      'a settled item is final; add a new item for the work',
    );
  }
  return item;
}

/** The instant a settle records: never earlier than the item's own `created_at`. */
function settledAt(item: ChecklistItem): string {
  const at = now();
  return at < item.created_at ? item.created_at : at;
}

async function write(
  store: Store,
  task: string,
  apply: (w: StoreWriter) => Promise<void>,
): Promise<EngineChecklist> {
  const view = await store.transact(async (w) => {
    await requireChecklistTask(w, task);
    await stamp(w, task);
    await apply(w);
    return { items: await w.loadChecklist(task), task };
  });
  return decodeChecklist(view);
}

const requireText = (value: string, what: string): void => {
  if (value.trim() === '') {
    throw validation(`${what} cannot be blank`);
  }
};

export function addItem(store: Store, task: string, content: string): Promise<EngineChecklist> {
  requireText(content, 'item content');
  return write(store, task, async (w) => {
    await w.insertChecklistItem({ content, created_at: now(), task });
  });
}

export function checkItem(store: Store, task: string, number: number): Promise<EngineChecklist> {
  return write(store, task, async (w) => {
    const item = await openItem(w, task, number);
    await w.settleChecklistItem(task, number, {
      reason: null,
      settled_at: settledAt(item),
      state: 'checked',
    });
  });
}

export function dropItem(
  store: Store,
  task: string,
  number: number,
  reason: string,
): Promise<EngineChecklist> {
  requireText(reason, 'drop reason');
  return write(store, task, async (w) => {
    const item = await openItem(w, task, number);
    await w.settleChecklistItem(task, number, {
      reason,
      settled_at: settledAt(item),
      state: 'dropped',
    });
  });
}
