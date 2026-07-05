import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Lifecycle } from '@mimir/contract';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, deriveSet, nodeStatusWord, statusOf } from './derive';
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

async function setLifecycle(id: number, lifecycle: Lifecycle): Promise<void> {
  await db.updateTable('node').set({ lifecycle }).where('id', '=', id).execute();
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

test('an initiative-level prerequisite gates a deep task and rolls the phase up to awaiting', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'dependent init' });
  const prereqInit = await createInitiative(store, { projectId: p.id, title: 'prereq init' });
  const prereqTask = await createTask(store, { parentId: prereqInit.id, title: 'prereq work' });
  await dep(init.id, prereqInit.id); // edge two levels above the leaf

  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  const deep = await createTask(store, { parentId: phase.id, title: 'deep' });

  // inherited across two levels (deep → phase → init), and the phase rolls up awaiting
  expect(nodeStatusWord(await setOf(), await reload(deep.id))).toBe('awaiting');
  expect(nodeStatusWord(await setOf(), await reload(phase.id))).toBe('awaiting');

  // the prerequisite initiative settles → the gate clears, top to bottom
  await setLifecycle(prereqTask.id, 'done');
  expect(nodeStatusWord(await setOf(), await reload(deep.id))).toBe('ready');
  expect(nodeStatusWord(await setOf(), await reload(phase.id))).toBe('ready');
});

test('an inherited gate is advisory: a started descendant stays in_progress', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase1 = await createPhase(store, { parentId: init.id, title: 'phase 1' });
  await createTask(store, { parentId: phase1.id, title: 'p1 work' }); // keeps phase 1 unsettled
  const phase2 = await createPhase(store, { parentId: init.id, title: 'phase 2' });
  await dep(phase2.id, phase1.id);
  const started = await createTask(store, { parentId: phase2.id, title: 'started early' });

  // gate governs picking up new work, not retroactively un-starting active work
  await setLifecycle(started.id, 'in_progress');
  expect(nodeStatusWord(await setOf(), await reload(started.id))).toBe('in_progress');
  // and the phase reads in_progress (live work beats the gate) — honest
  expect(nodeStatusWord(await setOf(), await reload(phase2.id))).toBe('in_progress');
});

test('a fresh phase of todo tasks rolls up to ready', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  await createTask(store, { parentId: phase.id, title: 't1' });
  await createTask(store, { parentId: phase.id, title: 't2' });

  expect(childDistribution(await setOf(), phase.id)).toEqual({ ready: 2 });
  expect(statusOf(await setOf(), await reload(phase.id)).status).toBe('ready');
  // initiative tallies the phase's word
  expect(statusOf(await setOf(), await reload(init.id)).status).toBe('ready');
});

test('live work beats ready in the rollup', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  const t1 = await createTask(store, { parentId: phase.id, title: 't1' });
  await createTask(store, { parentId: phase.id, title: 't2' });

  await setLifecycle(t1.id, 'in_progress');
  expect(childDistribution(await setOf(), phase.id)).toEqual({ in_progress: 1, ready: 1 });
  expect(statusOf(await setOf(), await reload(phase.id)).status).toBe('in_progress');
});

test('all-done rolls up to done; an empty phase is new', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  const t1 = await createTask(store, { parentId: phase.id, title: 't1' });
  await setLifecycle(t1.id, 'done');
  expect(statusOf(await setOf(), await reload(phase.id)).status).toBe('done');

  const empty = await createPhase(store, { parentId: init.id, title: 'empty' });
  expect(statusOf(await setOf(), await reload(empty.id)).status).toBe('new');

  // initiative over [done phase, new phase] → new (only undefined chunks remain after terminal)
  expect(statusOf(await setOf(), await reload(init.id)).status).toBe('new');
});

test('a task awaits an unsettled prerequisite and becomes ready once it settles', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  const prereq = await createTask(store, { parentId: phase.id, title: 'prereq' });
  const dependent = await createTask(store, { parentId: phase.id, title: 'dependent' });
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: prereq.id, node_id: dependent.id })
    .execute();

  expect(nodeStatusWord(await setOf(), await reload(dependent.id))).toBe('awaiting');

  await setLifecycle(prereq.id, 'done');
  expect(nodeStatusWord(await setOf(), await reload(dependent.id))).toBe('ready');

  // an abandoned prerequisite also settles the dependent (abandoned never freezes)
  const prereq2 = await createTask(store, { parentId: phase.id, title: 'prereq2' });
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: prereq2.id, node_id: dependent.id })
    .execute();
  expect(nodeStatusWord(await setOf(), await reload(dependent.id))).toBe('awaiting');
  await setLifecycle(prereq2.id, 'abandoned');
  expect(nodeStatusWord(await setOf(), await reload(dependent.id))).toBe('ready');
});

test('a container-dependency loop written behind the verbs throws the cycle invariant', async () => {
  // The depend/move guards reject this shape at write time (MMR-140); write the
  // raw rows to pin the read-side detection for data that predates the guards.
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const initA = await createInitiative(store, { projectId: p.id, title: 'A' });
  const b = await createTask(store, { parentId: initA.id, title: 'b' });
  const initC = await createInitiative(store, { projectId: p.id, title: 'C' });
  const d = await createTask(store, { parentId: initC.id, title: 'd' });
  await dep(b.id, initC.id); // A's task awaits C's rollup
  await dep(d.id, initA.id); // C's task awaits A's rollup — the loop

  const set = await setOf();
  const node = await reload(b.id);
  expect(() => nodeStatusWord(set, node)).toThrow(/derivation cycle/);
});
