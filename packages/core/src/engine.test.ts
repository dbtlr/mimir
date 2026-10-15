import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { getNode } from './intent';
import { errorOf } from './testing/conformance';
import { createTestStore } from './testing/store';
import type { TestStore } from './testing/store';

let fixture: TestStore;
let engine: LocalEngine;
let id: string;

beforeEach(async () => {
  fixture = await createTestStore();
  await createProject(fixture.store, { key: 'ENG', name: 'Engine' });
  const parent = await createInitiative(fixture.store, { projectId: 'ENG', title: 'Engine' });
  const task = await createTask(fixture.store, { parentId: parent.id, title: 'Prove the Engine' });
  id = task.id;
  engine = new LocalEngine(fixture.store);
});

afterEach(async () => fixture.close());

test('the Engine reads Date timestamps while the existing projection keeps strings', async () => {
  const result = await engine.getNode({ id });
  const projection = await getNode(fixture.store, id);
  expect(result.id).toBe(id);
  expect(result.createdAt).toBeInstanceOf(Date);
  expect(result.createdAt.toISOString()).toBe(projection.createdAt);
  expect(result.updatedAt.toISOString()).toBe(projection.updatedAt);
  expect(result.completedAt).toBeNull();
});

test('done returns the completed task and refuses a second completion', async () => {
  const result = await engine.done({ id });
  expect(result.lifecycle).toBe('done');
  expect(result.completedAt).toBeInstanceOf(Date);
  const read = await engine.getNode({
    facets: ['description', 'next', 'children', 'distribution'],
    id,
  });
  expect(read).toEqual(result);
  expect((await errorOf(engine.done({ id }))).code).toBe('validation');
});
