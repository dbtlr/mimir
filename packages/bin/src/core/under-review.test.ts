import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, deriveSet, nodeStatusWord } from './derive';
import { listNodes } from './intent';
import {
  abandonTask,
  blockTask,
  completeTask,
  returnTask,
  startTask,
  submitTask,
  unblockTask,
} from './mutations';
import { isStale } from './predicates';
import { interpret } from './status';
import type { Store } from './store';
import { createSqliteStore, loadWorkingSet } from './store-sqlite';
import { expectMimirError } from './testing';

/**
 * MMR-84 — the optional `under_review` ship-readiness gate: `submit`
 * (in_progress → under_review) and `return` (under_review → in_progress),
 * approval via `complete`, the rank/hold/stale/listing consequences.
 */

let db: Db;
let store: Store;
let projectId: number;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const setOf = async () => deriveSet(await loadWorkingSet(db));

async function startedTask(title = 't'): Promise<number> {
  const t = await createTask(store, { parentId: phaseId, title });
  await startTask(store, t.id);
  return t.id;
}

test('submit moves in_progress → under_review and clears rank', async () => {
  const id = await startedTask();
  expect((await store.transact((w) => w.loadNode(id)))?.rank).not.toBeNull();
  await submitTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('under_review');
  expect(node?.rank).toBeNull();
  expect(nodeStatusWord(await setOf(), node!)).toBe('under_review');
});

test('submit is legal only from in_progress', async () => {
  const todo = await createTask(store, { parentId: phaseId, title: 'x' });
  await expectMimirError('validation', () => submitTask(store, todo.id));
  const done = await startedTask();
  await completeTask(store, done);
  await expectMimirError('validation', () => submitTask(store, done));
});

test('return moves under_review → in_progress, re-ranks, and carries the reason', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  await returnTask(store, id, 'tests are missing');
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('in_progress');
  expect(node?.rank).not.toBeNull();

  const log = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('node_id', '=', id)
    .where('to_value', '=', 'in_progress')
    .where('from_value', '=', 'under_review')
    .executeTakeFirst();
  expect(log?.reason).toBe('tests are missing');
});

test('return is legal only from under_review', async () => {
  const id = await startedTask();
  await expectMimirError('validation', () => returnTask(store, id));
});

test('complete approves an under_review task, logging from=under_review', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  await completeTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('done');
  const log = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('node_id', '=', id)
    .where('to_value', '=', 'done')
    .executeTakeFirst();
  expect(log?.from_value).toBe('under_review');
});

test('an under_review task can be abandoned', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  await abandonTask(store, id, 'scrapped in review');
  expect((await store.transact((w) => w.loadNode(id)))?.lifecycle).toBe('abandoned');
});

test('holding an under_review task and releasing it does not make it rankable', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  await blockTask(store, id, 'reviewer OOO');
  await unblockTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('under_review');
  expect(node?.hold).toBe('none');
  expect(node?.rank).toBeNull(); // still non-rankable — not actionable until the verdict
});

test('stale chases an under_review task left too long', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  const future = new Date(Date.parse(node!.updated_at) + 30 * 24 * 60 * 60 * 1000).toISOString();
  expect(isStale(await setOf(), node!, { asOf: future })).toBe(true);
});

test('under_review tasks appear in the default (live) list and roll up a phase', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  const result = await listNodes(createSqliteStore(db), { scope: 'MMR' });
  expect(result.items.some((i) => i.status === 'under_review')).toBe(true);

  // the phase containing only this task rolls up to under_review
  expect(interpret(childDistribution(await setOf(), phaseId))).toBe('under_review');
});
