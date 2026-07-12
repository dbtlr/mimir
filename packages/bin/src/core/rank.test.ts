import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { RANK_STEP, reindexRanks, reorderTask } from './rank';
import type { RankPosition } from './rank';
import type { Store } from './store';

const NORN = Bun.which('norn') !== null;

const KEY = 'MMR';

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: number;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: KEY, name: 'm' });
  const projectId = await projectIdOf(store, KEY);
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `${KEY}-${String(init.seq)}`),
    title: 'ph',
  });
  phaseId = await nodeIdOf(store, `${KEY}-${String(phase.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

async function task(title: string): Promise<number> {
  const t = await createTask(store, { parentId: phaseId, title });
  return t.seq;
}

/** Task seqs in rank order (the order a consumer would see). */
async function rankedSeqs(): Promise<number[]> {
  const projectId = await projectIdOf(store, KEY);
  const ranked = await store.transact((w) => w.listRankedTasks(projectId));
  return ranked.map((r) => r.seq);
}

async function reorder(taskSeq: number, position: RankPosition, refSeq: number | null = null) {
  const projectId = await projectIdOf(store, KEY);
  const taskId = await nodeIdOf(store, `${KEY}-${String(taskSeq)}`);
  const refId = refSeq === null ? null : await nodeIdOf(store, `${KEY}-${String(refSeq)}`);
  await store.transact((w) => reorderTask(w, projectId, taskId, position, refId));
}

async function setRank(taskSeq: number, rank: number): Promise<void> {
  const id = await nodeIdOf(store, `${KEY}-${String(taskSeq)}`);
  await store.transact((w) => w.updateNode(id, { rank }));
}

test.skipIf(!NORN)('create appends in order at clean steps', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  expect(await rankedSeqs()).toEqual([a, b, c]);
});

test.skipIf(!NORN)('top and bottom move to the extremes', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');

  await reorder(c, 'top');
  expect(await rankedSeqs()).toEqual([c, a, b]);

  await reorder(c, 'bottom');
  expect(await rankedSeqs()).toEqual([a, b, c]);
});

test.skipIf(!NORN)('before and after place relative to a reference', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');

  await reorder(c, 'before', a);
  expect(await rankedSeqs()).toEqual([c, a, b]);

  await reorder(c, 'after', b);
  expect(await rankedSeqs()).toEqual([a, b, c]);

  await reorder(a, 'after', b);
  expect(await rankedSeqs()).toEqual([b, a, c]);
});

test.skipIf(!NORN)(
  'reindex re-spreads to clean multiples, order-preserving and idempotent',
  async () => {
    const a = await task('a');
    const b = await task('b');
    const c = await task('c');
    // scramble ranks into a tight, ugly range, preserving order a<b<c
    await setRank(a, 3);
    await setRank(b, 7);
    await setRank(c, 8);

    const projectId = await projectIdOf(store, KEY);
    await store.transact((w) => reindexRanks(w, projectId));
    let ranked = await store.transact((w) => w.listRankedTasks(projectId));
    expect(ranked.map((r) => r.seq)).toEqual([a, b, c]);
    expect(ranked.map((r) => r.rank)).toEqual([RANK_STEP, RANK_STEP * 2, RANK_STEP * 3]);

    // running again changes nothing
    await store.transact((w) => reindexRanks(w, projectId));
    ranked = await store.transact((w) => w.listRankedTasks(projectId));
    expect(ranked.map((r) => r.rank)).toEqual([RANK_STEP, RANK_STEP * 2, RANK_STEP * 3]);
  },
);

test.skipIf(!NORN)(
  'an exhausted midpoint triggers an on-the-spot reindex and still inserts',
  async () => {
    const a = await task('a');
    const b = await task('b');
    const c = await task('c');
    // make a and b adjacent so there is no integer midpoint between them
    await setRank(a, 1);
    await setRank(b, 2);
    await setRank(c, 100);

    // place c before b: neighbour below b is a (1,2 adjacent) → reindex, then midpoint
    await reorder(c, 'before', b);
    expect(await rankedSeqs()).toEqual([a, c, b]);
  },
);
