import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { abandonTask, completeTask, reopenTask, startTask, submitTask } from './mutations';
import type { Store } from './store';
import { createSqliteStore } from './store-sqlite';
import { expectMimirError } from './testing';

/**
 * MMR-104 — `reopen`: the deliberate correction path out of a terminal state.
 * done|abandoned → in_progress, re-ranked at the bottom, completed_at cleared,
 * the reason on the transition log; the original terminal transition is kept.
 */

let db: Db;
let store: Store;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

async function doneTask(): Promise<number> {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  await startTask(store, t.id);
  await completeTask(store, t.id);
  return t.id;
}

test('reopen moves done → in_progress, re-ranks, and clears completed_at', async () => {
  const id = await doneTask();
  expect((await store.transact((w) => w.loadNode(id)))?.rank).toBeNull();
  await reopenTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('in_progress');
  expect(node?.rank).not.toBeNull();
  expect(node?.completed_at).toBeNull();
});

test('reopen moves abandoned → in_progress', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't2' });
  await startTask(store, t.id);
  await abandonTask(store, t.id, 'wrong approach');
  await reopenTask(store, t.id);
  expect((await store.transact((w) => w.loadNode(t.id)))?.lifecycle).toBe('in_progress');
});

test('reopen carries the reason and preserves the original terminal transition', async () => {
  const id = await doneTask();
  await reopenTask(store, id, 'verification never ran');

  const reopenRow = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('node_id', '=', id)
    .where('from_value', '=', 'done')
    .where('to_value', '=', 'in_progress')
    .executeTakeFirst();
  expect(reopenRow?.reason).toBe('verification never ran');

  // the original in_progress → done row is still there (append-only)
  const doneRow = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('node_id', '=', id)
    .where('to_value', '=', 'done')
    .executeTakeFirst();
  expect(doneRow).toBeDefined();
});

test('reopen is legal only from a terminal state', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't3' });
  await expectMimirError('validation', () => reopenTask(store, t.id)); // todo
  await startTask(store, t.id);
  await expectMimirError('validation', () => reopenTask(store, t.id)); // in_progress
  await submitTask(store, t.id);
  await expectMimirError('validation', () => reopenTask(store, t.id)); // under_review
});

test('reopened then completed again re-stamps completed_at', async () => {
  const id = await doneTask();
  await reopenTask(store, id);
  await completeTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('done');
  expect(node?.completed_at).not.toBeNull();
});
