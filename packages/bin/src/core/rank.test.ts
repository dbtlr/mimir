import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { RANK_STEP, reindexRanks, reorderTask } from './rank';
import type { RankPosition } from './rank';

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

async function task(title: string): Promise<number> {
  const t = await createTask(db, { parentId: phaseId, title });
  return t.id;
}

/** Task ids in rank order (the order a consumer would see). */
async function rankedIds(): Promise<number[]> {
  const rows = await db
    .selectFrom('node')
    .select('id')
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null)
    .orderBy('rank', 'asc')
    .execute();
  return rows.map((r) => r.id);
}

async function reorder(taskId: number, position: RankPosition, refId: number | null = null) {
  await db.transaction().execute((tx) => reorderTask(tx, projectId, taskId, position, refId));
}

async function setRank(taskId: number, rank: number): Promise<void> {
  await db.updateTable('node').set({ rank }).where('id', '=', taskId).execute();
}

test('create appends in order at clean steps', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  expect(await rankedIds()).toEqual([a, b, c]);
});

test('top and bottom move to the extremes', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');

  await reorder(c, 'top');
  expect(await rankedIds()).toEqual([c, a, b]);

  await reorder(c, 'bottom');
  expect(await rankedIds()).toEqual([a, b, c]);
});

test('before and after place relative to a reference', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');

  await reorder(c, 'before', a);
  expect(await rankedIds()).toEqual([c, a, b]);

  await reorder(c, 'after', b);
  expect(await rankedIds()).toEqual([a, b, c]);

  await reorder(a, 'after', b);
  expect(await rankedIds()).toEqual([b, a, c]);
});

test('reindex re-spreads to clean multiples, order-preserving and idempotent', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  // scramble ranks into a tight, ugly range, preserving order a<b<c
  await setRank(a, 3);
  await setRank(b, 7);
  await setRank(c, 8);

  await db.transaction().execute((tx) => reindexRanks(tx, projectId));
  let rows = await db
    .selectFrom('node')
    .select(['id', 'rank'])
    .where('rank', 'is not', null)
    .orderBy('rank', 'asc')
    .execute();
  expect(rows.map((r) => r.id)).toEqual([a, b, c]);
  expect(rows.map((r) => r.rank)).toEqual([RANK_STEP, RANK_STEP * 2, RANK_STEP * 3]);

  // running again changes nothing
  await db.transaction().execute((tx) => reindexRanks(tx, projectId));
  rows = await db
    .selectFrom('node')
    .select(['id', 'rank'])
    .where('rank', 'is not', null)
    .orderBy('rank', 'asc')
    .execute();
  expect(rows.map((r) => r.rank)).toEqual([RANK_STEP, RANK_STEP * 2, RANK_STEP * 3]);
});

test('an exhausted midpoint triggers an on-the-spot reindex and still inserts', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  // make a and b adjacent so there is no integer midpoint between them
  await setRank(a, 1);
  await setRank(b, 2);
  await setRank(c, 100);

  // place c before b: neighbour below b is a (1,2 adjacent) → reindex, then midpoint
  await reorder(c, 'before', b);
  expect(await rankedIds()).toEqual([a, c, b]);
});
