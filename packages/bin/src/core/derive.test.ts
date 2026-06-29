import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Lifecycle } from '@mimir/contract';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, nodeStatusWord, statusOf } from './derive';
import { loadNode } from './lookup';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

async function setLifecycle(id: number, lifecycle: Lifecycle): Promise<void> {
  await db.updateTable('node').set({ lifecycle }).where('id', '=', id).execute();
}

async function reload(id: number) {
  const node = await loadNode(db, id);
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}

test('a fresh phase of todo tasks rolls up to ready', async () => {
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  await createTask(db, { parentId: phase.id, title: 't1' });
  await createTask(db, { parentId: phase.id, title: 't2' });

  expect(await childDistribution(db, phase.id)).toEqual({ ready: 2 });
  expect((await statusOf(db, await reload(phase.id))).status).toBe('ready');
  // initiative tallies the phase's word
  expect((await statusOf(db, await reload(init.id))).status).toBe('ready');
});

test('live work beats ready in the rollup', async () => {
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  const t1 = await createTask(db, { parentId: phase.id, title: 't1' });
  await createTask(db, { parentId: phase.id, title: 't2' });

  await setLifecycle(t1.id, 'in_progress');
  expect(await childDistribution(db, phase.id)).toEqual({ in_progress: 1, ready: 1 });
  expect((await statusOf(db, await reload(phase.id))).status).toBe('in_progress');
});

test('all-done rolls up to done; an empty phase is new', async () => {
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  const t1 = await createTask(db, { parentId: phase.id, title: 't1' });
  await setLifecycle(t1.id, 'done');
  expect((await statusOf(db, await reload(phase.id))).status).toBe('done');

  const empty = await createPhase(db, { parentId: init.id, title: 'empty' });
  expect((await statusOf(db, await reload(empty.id))).status).toBe('new');

  // initiative over [done phase, new phase] → new (only undefined chunks remain after terminal)
  expect((await statusOf(db, await reload(init.id))).status).toBe('new');
});

test('a task awaits an unsettled prerequisite and becomes ready once it settles', async () => {
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  const prereq = await createTask(db, { parentId: phase.id, title: 'prereq' });
  const dependent = await createTask(db, { parentId: phase.id, title: 'dependent' });
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: prereq.id, node_id: dependent.id })
    .execute();

  expect(await nodeStatusWord(db, await reload(dependent.id))).toBe('awaiting');

  await setLifecycle(prereq.id, 'done');
  expect(await nodeStatusWord(db, await reload(dependent.id))).toBe('ready');

  // an abandoned prerequisite also settles the dependent (abandoned never freezes)
  const prereq2 = await createTask(db, { parentId: phase.id, title: 'prereq2' });
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: prereq2.id, node_id: dependent.id })
    .execute();
  expect(await nodeStatusWord(db, await reload(dependent.id))).toBe('awaiting');
  await setLifecycle(prereq2.id, 'abandoned');
  expect(await nodeStatusWord(db, await reload(dependent.id))).toBe('ready');
});
