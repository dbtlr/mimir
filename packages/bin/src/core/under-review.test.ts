import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, deriveSet, nodeStatusWord } from './derive';
import { listNodes } from './intent';
import { loadNode } from './lookup';
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
import { createSqliteStore, loadWorkingSet } from './store-sqlite';
import { expectMimirError } from './testing';

/**
 * MMR-84 — the optional `under_review` ship-readiness gate: `submit`
 * (in_progress → under_review) and `return` (under_review → in_progress),
 * approval via `complete`, the rank/hold/stale/listing consequences.
 */

let db: Db;
let projectId: number;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(db, { projectId, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const setOf = async () => deriveSet(await loadWorkingSet(db));

async function startedTask(title = 't'): Promise<number> {
  const t = await createTask(db, { parentId: phaseId, title });
  await startTask(db, t.id);
  return t.id;
}

test('submit moves in_progress → under_review and clears rank', async () => {
  const id = await startedTask();
  expect((await loadNode(db, id))?.rank).not.toBeNull();
  await submitTask(db, id);
  const node = await loadNode(db, id);
  expect(node?.lifecycle).toBe('under_review');
  expect(node?.rank).toBeNull();
  expect(nodeStatusWord(await setOf(), node!)).toBe('under_review');
});

test('submit is legal only from in_progress', async () => {
  const todo = await createTask(db, { parentId: phaseId, title: 'x' });
  await expectMimirError('validation', () => submitTask(db, todo.id));
  const done = await startedTask();
  await completeTask(db, done);
  await expectMimirError('validation', () => submitTask(db, done));
});

test('return moves under_review → in_progress, re-ranks, and carries the reason', async () => {
  const id = await startedTask();
  await submitTask(db, id);
  await returnTask(db, id, 'tests are missing');
  const node = await loadNode(db, id);
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
  await expectMimirError('validation', () => returnTask(db, id));
});

test('complete approves an under_review task, logging from=under_review', async () => {
  const id = await startedTask();
  await submitTask(db, id);
  await completeTask(db, id);
  const node = await loadNode(db, id);
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
  await submitTask(db, id);
  await abandonTask(db, id, 'scrapped in review');
  expect((await loadNode(db, id))?.lifecycle).toBe('abandoned');
});

test('holding an under_review task and releasing it does not make it rankable', async () => {
  const id = await startedTask();
  await submitTask(db, id);
  await blockTask(db, id, 'reviewer OOO');
  await unblockTask(db, id);
  const node = await loadNode(db, id);
  expect(node?.lifecycle).toBe('under_review');
  expect(node?.hold).toBe('none');
  expect(node?.rank).toBeNull(); // still non-rankable — not actionable until the verdict
});

test('stale chases an under_review task left too long', async () => {
  const id = await startedTask();
  await submitTask(db, id);
  const node = await loadNode(db, id);
  const future = new Date(Date.parse(node!.updated_at) + 30 * 24 * 60 * 60 * 1000).toISOString();
  expect(isStale(await setOf(), node!, { asOf: future })).toBe(true);
});

test('under_review tasks appear in the default (live) list and roll up a phase', async () => {
  const id = await startedTask();
  await submitTask(db, id);
  const result = await listNodes(createSqliteStore(db), { scope: 'MMR' });
  expect(result.items.some((i) => i.status === 'under_review')).toBe(true);

  // the phase containing only this task rolls up to under_review
  expect(interpret(childDistribution(await setOf(), phaseId))).toBe('under_review');
});
