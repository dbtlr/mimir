import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { completeTask, groomTasks, startTask } from './index';

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
let initId: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

async function task(): Promise<string> {
  const created = await createTask(store, { parentId: phaseId, title: 't' });
  return nodeIdOf(store, `MMR-${String(created.seq)}`);
}
async function reload(id: string) {
  const node = await store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}
async function notes(id: string): Promise<string[]> {
  const stem = (await reload(id)).id;
  return (await store.bodySections.readAnnotations(stem)).map((n) => n.content);
}

test('groom sets the state on every task in one call and returns the reloaded nodes', async () => {
  const [a, b] = [await task(), await task()];
  const nodes = await groomTasks(store, [a, b], 'groomed');
  expect(nodes.map((n) => n.grooming)).toEqual(['groomed', 'groomed']);
  expect((await reload(a)).grooming).toBe('groomed');
  expect((await reload(b)).grooming).toBe('groomed');
});

test('groom writes the note as an annotation on every task, and stamps them', async () => {
  const [a, b] = [await task(), await task()];
  const before = (await reload(a)).updated_at;
  await Bun.sleep(5);
  await groomTasks(store, [a, b], 'needs_answers', 'which backend owns the retry?');
  expect(await notes(a)).toEqual(['which backend owns the retry?']);
  expect(await notes(b)).toEqual(['which backend owns the retry?']);
  expect((await reload(a)).updated_at > before).toBe(true);
  expect((await reload(a)).grooming).toBe('needs_answers');
});

test('groom without a note writes no annotation', async () => {
  const a = await task();
  await groomTasks(store, [a], 'groomed');
  expect(await notes(a)).toEqual([]);
});

test('needs_answers requires a non-empty note, and a refusal writes nothing', async () => {
  const a = await task();
  await expectMimirError('validation', () => groomTasks(store, [a], 'needs_answers'));
  await expectMimirError('validation', () => groomTasks(store, [a], 'needs_answers', '   '));
  expect((await reload(a)).grooming).toBe('not_groomed');
});

test('groom validates every id before writing anything', async () => {
  const a = await task();
  await expectMimirError('not_found', () => groomTasks(store, [a, 'MMR-999'], 'groomed', 'note'));
  await expectMimirError('validation', () => groomTasks(store, [a, phaseId], 'groomed', 'note'));
  expect((await reload(a)).grooming).toBe('not_groomed');
  expect(await notes(a)).toEqual([]);
});

test('groom is allowed at any lifecycle, re-setting the same state is a no-op on the field, and it logs no transition', async () => {
  const a = await task();
  await startTask(store, a);
  await completeTask(store, a);
  const logged = (await store.transitions.list()).items.length;
  await groomTasks(store, [a], 'groomed');
  await groomTasks(store, [a], 'groomed', 'still fine');
  expect((await reload(a)).grooming).toBe('groomed');
  expect(await notes(a)).toEqual(['still fine']);
  expect((await store.transitions.list()).items.length).toBe(logged);
});
