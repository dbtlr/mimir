import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { createTestStore, nodeIdOf, projectIdOf, rawDep, rawPatchNode } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet } from './derive';
import { isAwaiting, isBlocked, isBlocking, isOrphaned, isReady, isStale } from './predicates';
import type { Store } from './store';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
});
afterEach(async () => {
  await closeStore();
});

const setOf = async () => deriveSet(await store.loadWorkingSet());

async function patch(
  key: string,
  seq: number,
  fields: { lifecycle?: Lifecycle; hold?: Hold },
): Promise<void> {
  await rawPatchNode(store, await nodeIdOf(store, `${key}-${String(seq)}`), fields);
}
async function reload(key: string, seq: number) {
  const id = await nodeIdOf(store, `${key}-${String(seq)}`);
  const node = await store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${key}-${String(seq)} vanished`);
  }
  return node;
}
async function dep(key: string, nodeSeq: number, dependsOnSeq: number): Promise<void> {
  const nodeId = await nodeIdOf(store, `${key}-${String(nodeSeq)}`);
  const dependsOnId = await nodeIdOf(store, `${key}-${String(dependsOnSeq)}`);
  await rawDep(store, nodeId, dependsOnId);
}

async function fixture(key = 'MMR') {
  const p = await createProject(store, { key, name: 'm' });
  const projectId = await projectIdOf(store, key);
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `${key}-${String(init.seq)}`),
    title: 'ph',
  });
  return { init, key, p, phase };
}

test.skipIf(!NORN)('ready vs awaiting hinge on prerequisite settledness', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  expect(isReady(await setOf(), a)).toBe(true);
  expect(isAwaiting(await setOf(), a)).toBe(false);

  await dep(key, b.seq, a.seq);
  expect(isReady(await setOf(), await reload(key, b.seq))).toBe(false);
  expect(isAwaiting(await setOf(), await reload(key, b.seq))).toBe(true);

  await patch(key, a.seq, { lifecycle: 'done' });
  expect(isReady(await setOf(), await reload(key, b.seq))).toBe(true);
  expect(isAwaiting(await setOf(), await reload(key, b.seq))).toBe(false);
});

test.skipIf(!NORN)(
  'a task inherits its ancestor phase prerequisite (reads awaiting, clears to ready)',
  async () => {
    const { init, key, phase } = await fixture();
    // a sibling "phase 1" with a live task → unsettled prerequisite
    const initId = await nodeIdOf(store, `${key}-${String(init.seq)}`);
    const phase1 = await createPhase(store, { parentId: initId, title: 'phase 1' });
    const p1task = await createTask(store, {
      parentId: await nodeIdOf(store, `${key}-${String(phase1.seq)}`),
      title: 'p1 work',
    });
    // "phase 2" (the fixture phase) depends on phase 1, and holds a task
    await dep(key, phase.seq, phase1.seq);
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
      title: 't',
    });

    // t declares no edge of its own, yet inherits phase 2's gate
    expect(isReady(await setOf(), await reload(key, t.seq))).toBe(false);
    expect(isAwaiting(await setOf(), await reload(key, t.seq))).toBe(true);

    // phase 1 settles (its only task done) → t clears to ready
    await patch(key, p1task.seq, { lifecycle: 'done' });
    expect(isReady(await setOf(), await reload(key, t.seq))).toBe(true);
    expect(isAwaiting(await setOf(), await reload(key, t.seq))).toBe(false);
  },
);

test.skipIf(!NORN)('a held task is neither ready nor awaiting', async () => {
  const { key, phase } = await fixture();
  const t = await createTask(store, {
    parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
    title: 't',
  });
  await patch(key, t.seq, { hold: 'blocked' });
  expect(isReady(await setOf(), await reload(key, t.seq))).toBe(false);
  expect(isAwaiting(await setOf(), await reload(key, t.seq))).toBe(false);
  expect(isBlocked(await reload(key, t.seq))).toBe(true);
});

test.skipIf(!NORN)('blocking is true while an unsettled dependent exists', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const prereq = await createTask(store, { parentId: phaseId, title: 'prereq' });
  const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
  await dep(key, dependent.seq, prereq.seq);

  expect(isBlocking(await setOf(), await reload(key, prereq.seq))).toBe(true);
  await patch(key, dependent.seq, { lifecycle: 'done' });
  expect(isBlocking(await setOf(), await reload(key, prereq.seq))).toBe(false);
});

test.skipIf(!NORN)(
  'stale chases in_progress/blocked, mutes parked/awaiting, respects the threshold',
  async () => {
    const { key, phase } = await fixture();
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
      title: 't',
    });
    await patch(key, t.seq, { lifecycle: 'in_progress' });
    // backdate updated_at well past the threshold
    const id = await nodeIdOf(store, `${key}-${String(t.seq)}`);
    await store.transact((w) => w.updateNode(id, { updated_at: '2000-01-01T00:00:00.000Z' }));
    const asOf = '2026-06-05T00:00:00.000Z';

    expect(isStale(await setOf(), await reload(key, t.seq), { asOf })).toBe(true);

    // parked is muted even when ancient
    await patch(key, t.seq, { hold: 'parked' });
    expect(isStale(await setOf(), await reload(key, t.seq), { asOf })).toBe(false);

    // fresh in_progress is not stale
    await patch(key, t.seq, { hold: 'none' });
    const id2 = await nodeIdOf(store, `${key}-${String(t.seq)}`);
    await store.transact((w) => w.updateNode(id2, { updated_at: asOf }));
    expect(isStale(await setOf(), await reload(key, t.seq), { asOf })).toBe(false);
  },
);

test.skipIf(!NORN)('orphaned: a live task stranded among all-terminal siblings', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const live = await createTask(store, { parentId: phaseId, title: 'live' });
  const sib = await createTask(store, { parentId: phaseId, title: 'sib' });

  // two live siblings → not orphaned
  expect(isOrphaned(await setOf(), await reload(key, live.seq))).toBe(false);

  // sibling done → the live one is now stranded
  await patch(key, sib.seq, { lifecycle: 'done' });
  expect(isOrphaned(await setOf(), await reload(key, live.seq))).toBe(true);

  // a sole child is never orphaned
  const { key: soloKey, phase: solo } = await fixture('SOL');
  const only = await createTask(store, {
    parentId: await nodeIdOf(store, `${soloKey}-${String(solo.seq)}`),
    title: 'only',
  });
  expect(isOrphaned(await setOf(), await reload(soloKey, only.seq))).toBe(false);
});

test.skipIf(!NORN)('orphaned: muted for a live task inside an open-ended container', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const live = await createTask(store, { parentId: phaseId, title: 'live' });
  const sib = await createTask(store, { parentId: phaseId, title: 'sib' });
  await patch(key, sib.seq, { lifecycle: 'done' });

  // normal container: every-other-sibling-terminal → orphaned
  expect(isOrphaned(await setOf(), await reload(key, live.seq))).toBe(true);

  // open-ended container: every-sibling-terminal is structurally meaningless → muted
  const openId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  await rawPatchNode(store, openId, { open_ended: true });
  expect(isOrphaned(await setOf(), await reload(key, live.seq))).toBe(false);
});
