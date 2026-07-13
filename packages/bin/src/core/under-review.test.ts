import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore } from '../testing/store';
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
import { expectMimirError } from './testing';

/**
 * MMR-84 — the optional `under_review` ship-readiness gate: `submit`
 * (in_progress → under_review) and `return` (under_review → in_progress),
 * approval via `complete`, the rank/hold/stale/listing consequences.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

const setOf = async () => deriveSet(await store.loadWorkingSet());

async function startedTask(title = 't'): Promise<string> {
  const t = await createTask(store, { parentId: phaseId, title });
  const id = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  await startTask(store, id);
  return id;
}

test.skipIf(!NORN)('submit moves in_progress → under_review and clears rank', async () => {
  const id = await startedTask();
  expect((await store.transact((w) => w.loadNode(id)))?.rank).not.toBeNull();
  await submitTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('under_review');
  expect(node?.rank).toBeNull();
  expect(nodeStatusWord(await setOf(), node!)).toBe('under_review');
});

test.skipIf(!NORN)('submit is legal only from in_progress', async () => {
  const todo = await createTask(store, { parentId: phaseId, title: 'x' });
  const todoId = await nodeIdOf(store, `MMR-${String(todo.seq)}`);
  await expectMimirError('validation', () => submitTask(store, todoId));
  const done = await startedTask();
  await completeTask(store, done);
  await expectMimirError('validation', () => submitTask(store, done));
});

test.skipIf(!NORN)(
  'return moves under_review → in_progress, re-ranks, and carries the reason',
  async () => {
    const id = await startedTask();
    await submitTask(store, id);
    await returnTask(store, id, 'tests are missing');
    const node = await store.transact((w) => w.loadNode(id));
    expect(node?.lifecycle).toBe('in_progress');
    expect(node?.rank).not.toBeNull();

    const { items } = await store.transitions.list();
    const log = items.find(
      (t) =>
        t.node === `MMR-${String(node!.seq)}` &&
        t.to === 'in_progress' &&
        t.from === 'under_review',
    );
    expect(log?.reason).toBe('tests are missing');
  },
);

test.skipIf(!NORN)('return is legal only from under_review', async () => {
  const id = await startedTask();
  await expectMimirError('validation', () => returnTask(store, id));
});

test.skipIf(!NORN)(
  'complete approves an under_review task, logging from=under_review',
  async () => {
    const id = await startedTask();
    await submitTask(store, id);
    await completeTask(store, id);
    const node = await store.transact((w) => w.loadNode(id));
    expect(node?.lifecycle).toBe('done');
    const { items } = await store.transitions.list();
    const log = items.find((t) => t.node === `MMR-${String(node!.seq)}` && t.to === 'done');
    expect(log?.from).toBe('under_review');
  },
);

test.skipIf(!NORN)('an under_review task can be abandoned', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  await abandonTask(store, id, 'scrapped in review');
  expect((await store.transact((w) => w.loadNode(id)))?.lifecycle).toBe('abandoned');
});

test.skipIf(!NORN)(
  'holding an under_review task and releasing it does not make it rankable',
  async () => {
    const id = await startedTask();
    await submitTask(store, id);
    await blockTask(store, id, 'reviewer OOO');
    await unblockTask(store, id);
    const node = await store.transact((w) => w.loadNode(id));
    expect(node?.lifecycle).toBe('under_review');
    expect(node?.hold).toBe('none');
    expect(node?.rank).toBeNull(); // still non-rankable — not actionable until the verdict
  },
);

test.skipIf(!NORN)('stale chases an under_review task left too long', async () => {
  const id = await startedTask();
  await submitTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  const future = new Date(Date.parse(node!.updated_at) + 30 * 24 * 60 * 60 * 1000).toISOString();
  expect(isStale(await setOf(), node!, { asOf: future })).toBe(true);
});

test.skipIf(!NORN)(
  'under_review tasks appear in the default (live) list and roll up a phase',
  async () => {
    const id = await startedTask();
    await submitTask(store, id);
    const result = await listNodes(store, { scope: 'MMR' });
    expect(result.items.some((i) => i.status === 'under_review')).toBe(true);

    // the phase containing only this task rolls up to under_review
    expect(interpret(childDistribution(await setOf(), phaseId))).toBe('under_review');
  },
);
