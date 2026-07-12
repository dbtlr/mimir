import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { abandonTask, completeTask, reopenTask, startTask, submitTask } from './mutations';
import type { Store } from './store';
import { expectMimirError } from './testing';

/**
 * MMR-104 — `reopen`: the deliberate correction path out of a terminal state.
 * done|abandoned → in_progress, re-ranked at the bottom, completed_at cleared,
 * the reason on the transition log; the original terminal transition is kept.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: number;
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

async function doneTask(): Promise<number> {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const id = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  await startTask(store, id);
  await completeTask(store, id);
  return id;
}

test.skipIf(!NORN)(
  'reopen moves done → in_progress, re-ranks, and clears completed_at',
  async () => {
    const id = await doneTask();
    expect((await store.transact((w) => w.loadNode(id)))?.rank).toBeNull();
    await reopenTask(store, id);
    const node = await store.transact((w) => w.loadNode(id));
    expect(node?.lifecycle).toBe('in_progress');
    expect(node?.rank).not.toBeNull();
    expect(node?.completed_at).toBeNull();
  },
);

test.skipIf(!NORN)('reopen moves abandoned → in_progress', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't2' });
  const id = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  await startTask(store, id);
  await abandonTask(store, id, 'wrong approach');
  await reopenTask(store, id);
  expect((await store.transact((w) => w.loadNode(id)))?.lifecycle).toBe('in_progress');
});

test.skipIf(!NORN)(
  'reopen carries the reason and preserves the original terminal transition',
  async () => {
    const id = await doneTask();
    const node = await store.transact((w) => w.loadNode(id));
    await reopenTask(store, id, 'verification never ran');

    const { items } = await store.transitions.list();
    const reopenEntry = items.find(
      (t) => t.node === `MMR-${String(node!.seq)}` && t.from === 'done' && t.to === 'in_progress',
    );
    expect(reopenEntry?.reason).toBe('verification never ran');

    // the original in_progress → done row is still there (append-only)
    const doneEntry = items.find((t) => t.node === `MMR-${String(node!.seq)}` && t.to === 'done');
    expect(doneEntry).toBeDefined();
  },
);

test.skipIf(!NORN)('reopen is legal only from a terminal state', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't3' });
  const id = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  await expectMimirError('validation', () => reopenTask(store, id)); // todo
  await startTask(store, id);
  await expectMimirError('validation', () => reopenTask(store, id)); // in_progress
  await submitTask(store, id);
  await expectMimirError('validation', () => reopenTask(store, id)); // under_review
});

test.skipIf(!NORN)('reopened then completed again re-stamps completed_at', async () => {
  const id = await doneTask();
  await reopenTask(store, id);
  await completeTask(store, id);
  const node = await store.transact((w) => w.loadNode(id));
  expect(node?.lifecycle).toBe('done');
  expect(node?.completed_at).not.toBeNull();
});
