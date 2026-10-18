import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { getNode } from './intent';
import { startTask } from './mutations';
import { OP_SPECS } from './ops';
import { createScratchpadService } from './scratchpads';
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

test('scratchList puts a staged freeze first, then the newest Scratchpad', async () => {
  let clock = '2026-01-01T00:00:00.000Z';
  const scratch = createScratchpadService(
    fixture.store.scratchpads,
    fixture.store.artifacts,
    fixture.store,
    { clock: () => clock },
  );
  const freezing = await scratch.create({ project: 'ENG', title: 'Freezing' });
  const stamp = '2026-01-01T00:00:01.000Z';
  await fixture.store.scratchpads.replace(
    { ...freezing, freezingAt: stamp, updatedAt: stamp },
    freezing.updatedAt,
  );
  clock = '2026-01-02T00:00:00.000Z';
  const older = await scratch.create({ project: 'ENG', title: 'Older' });
  clock = '2026-01-03T00:00:00.000Z';
  const newer = await scratch.create({ project: 'ENG', title: 'Newer' });
  const rows = await engine.scratchList({ project: 'ENG' });
  expect(rows.map((row) => row.id)).toEqual([freezing.id, newer.id, older.id]);
  expect(rows[0]?.state).toBe('freezing');
  expect(rows[1]?.updatedAt).toEqual(new Date(clock));
});

test('overview judges staleness at the Date the caller passes', async () => {
  await startTask(fixture.store, id);
  expect((await engine.overview({ project: 'ENG' })).hygiene.stale).toBe(0);
  const later = await engine.overview({
    asOf: new Date('2100-01-01T00:00:00.000Z'),
    project: 'ENG',
  });
  expect(later.hygiene.stale).toBe(1);
});

test('malformed input reads as a sentence naming the field, not an issue dump', async () => {
  const refusal = await errorOf(engine.next({} as Parameters<LocalEngine['next']>[0]));
  expect(refusal.code).toBe('validation');
  expect(refusal.message).toContain('project');
  expect(refusal.message).not.toContain('"code"');
});

test('every operation-registry verb is a LocalEngine method taking its fact arguments', async () => {
  for (const spec of OP_SPECS) {
    expect(typeof Reflect.get(engine, spec.verb)).toBe('function');
  }
  const started = await engine.start({ id, session: 'engine-test' });
  expect(started.lifecycle).toBe('in_progress');
  expect(started.session).toBe('engine-test');
  const refusal = await errorOf(
    engine.done({ id, reason: 'no such argument' } as Parameters<LocalEngine['done']>[0]),
  );
  expect(refusal.code).toBe('validation');
});

test('a node write echoes the written record with Date instants', async () => {
  const created = await engine.create({ parent: 'ENG-1', title: 'Nested', type: 'task' });
  expect(created.id).not.toBe(id);
  expect(created.createdAt).toBeInstanceOf(Date);
  const project = await engine.updateProject({ id: 'ENG', next: 'Direction', pinned: true });
  expect(project.pinned).toBe(true);
  expect(project.next).toBe('Direction');
});
