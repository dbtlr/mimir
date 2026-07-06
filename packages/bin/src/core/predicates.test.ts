import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet } from './derive';
import { isAwaiting, isBlocked, isBlocking, isOrphaned, isReady, isStale } from './predicates';
import type { Store } from './store';
import { createSqliteStore, loadWorkingSet } from './store-sqlite';

let db: Db;
let store: Store;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
});
afterEach(async () => {
  await db.destroy();
});

const setOf = async () => deriveSet(await loadWorkingSet(db));

async function patch(id: number, fields: { lifecycle?: Lifecycle; hold?: Hold }): Promise<void> {
  await db.updateTable('node').set(fields).where('id', '=', id).execute();
}
async function reload(id: number) {
  const node = await store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}
async function dep(nodeId: number, dependsOn: number): Promise<void> {
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: dependsOn, node_id: nodeId })
    .execute();
}

async function fixture(key = 'MMR') {
  const p = await createProject(store, { key, name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  return { init, p, phase };
}

test('ready vs awaiting hinge on prerequisite settledness', async () => {
  const { phase } = await fixture();
  const a = await createTask(store, { parentId: phase.id, title: 'a' });
  const b = await createTask(store, { parentId: phase.id, title: 'b' });
  expect(isReady(await setOf(), a)).toBe(true);
  expect(isAwaiting(await setOf(), a)).toBe(false);

  await dep(b.id, a.id);
  expect(isReady(await setOf(), await reload(b.id))).toBe(false);
  expect(isAwaiting(await setOf(), await reload(b.id))).toBe(true);

  await patch(a.id, { lifecycle: 'done' });
  expect(isReady(await setOf(), await reload(b.id))).toBe(true);
  expect(isAwaiting(await setOf(), await reload(b.id))).toBe(false);
});

test('a task inherits its ancestor phase prerequisite (reads awaiting, clears to ready)', async () => {
  const { init, phase } = await fixture();
  // a sibling "phase 1" with a live task → unsettled prerequisite
  const phase1 = await createPhase(store, { parentId: init.id, title: 'phase 1' });
  const p1task = await createTask(store, { parentId: phase1.id, title: 'p1 work' });
  // "phase 2" (the fixture phase) depends on phase 1, and holds a task
  await dep(phase.id, phase1.id);
  const t = await createTask(store, { parentId: phase.id, title: 't' });

  // t declares no edge of its own, yet inherits phase 2's gate
  expect(isReady(await setOf(), await reload(t.id))).toBe(false);
  expect(isAwaiting(await setOf(), await reload(t.id))).toBe(true);

  // phase 1 settles (its only task done) → t clears to ready
  await patch(p1task.id, { lifecycle: 'done' });
  expect(isReady(await setOf(), await reload(t.id))).toBe(true);
  expect(isAwaiting(await setOf(), await reload(t.id))).toBe(false);
});

test('a held task is neither ready nor awaiting', async () => {
  const { phase } = await fixture();
  const t = await createTask(store, { parentId: phase.id, title: 't' });
  await patch(t.id, { hold: 'blocked' });
  expect(isReady(await setOf(), await reload(t.id))).toBe(false);
  expect(isAwaiting(await setOf(), await reload(t.id))).toBe(false);
  expect(isBlocked(await reload(t.id))).toBe(true);
});

test('blocking is true while an unsettled dependent exists', async () => {
  const { phase } = await fixture();
  const prereq = await createTask(store, { parentId: phase.id, title: 'prereq' });
  const dependent = await createTask(store, { parentId: phase.id, title: 'dependent' });
  await dep(dependent.id, prereq.id);

  expect(isBlocking(await setOf(), await reload(prereq.id))).toBe(true);
  await patch(dependent.id, { lifecycle: 'done' });
  expect(isBlocking(await setOf(), await reload(prereq.id))).toBe(false);
});

test('stale chases in_progress/blocked, mutes parked/awaiting, respects the threshold', async () => {
  const { phase } = await fixture();
  const t = await createTask(store, { parentId: phase.id, title: 't' });
  await patch(t.id, { lifecycle: 'in_progress' });
  // backdate updated_at well past the threshold
  await db
    .updateTable('node')
    .set({ updated_at: '2000-01-01T00:00:00.000Z' })
    .where('id', '=', t.id)
    .execute();
  const asOf = '2026-06-05T00:00:00.000Z';

  expect(isStale(await setOf(), await reload(t.id), { asOf })).toBe(true);

  // parked is muted even when ancient
  await patch(t.id, { hold: 'parked' });
  expect(isStale(await setOf(), await reload(t.id), { asOf })).toBe(false);

  // fresh in_progress is not stale
  await patch(t.id, { hold: 'none' });
  await db.updateTable('node').set({ updated_at: asOf }).where('id', '=', t.id).execute();
  expect(isStale(await setOf(), await reload(t.id), { asOf })).toBe(false);
});

test('orphaned: a live task stranded among all-terminal siblings', async () => {
  const { phase } = await fixture();
  const live = await createTask(store, { parentId: phase.id, title: 'live' });
  const sib = await createTask(store, { parentId: phase.id, title: 'sib' });

  // two live siblings → not orphaned
  expect(isOrphaned(await setOf(), await reload(live.id))).toBe(false);

  // sibling done → the live one is now stranded
  await patch(sib.id, { lifecycle: 'done' });
  expect(isOrphaned(await setOf(), await reload(live.id))).toBe(true);

  // a sole child is never orphaned
  const { phase: solo } = await fixture('SOL');
  const only = await createTask(store, { parentId: solo.id, title: 'only' });
  expect(isOrphaned(await setOf(), await reload(only.id))).toBe(false);
});

test('orphaned: muted for a live task inside an open-ended container', async () => {
  const { phase } = await fixture();
  const live = await createTask(store, { parentId: phase.id, title: 'live' });
  const sib = await createTask(store, { parentId: phase.id, title: 'sib' });
  await patch(sib.id, { lifecycle: 'done' });

  // normal container: every-other-sibling-terminal → orphaned
  expect(isOrphaned(await setOf(), await reload(live.id))).toBe(true);

  // open-ended container: every-sibling-terminal is structurally meaningless → muted
  await db.updateTable('node').set({ open_ended: true }).where('id', '=', phase.id).execute();
  expect(isOrphaned(await setOf(), await reload(live.id))).toBe(false);
});
