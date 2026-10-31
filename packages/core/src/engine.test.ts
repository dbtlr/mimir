import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { getNode } from './intent';
import { archiveProject, startTask } from './mutations';
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

test('projectsByRemote finds every active project of one repository, whatever the URL form', async () => {
  await engine.create({
    key: 'AAA',
    name: 'Alpha',
    remote: 'git@GitHub.com:dbtlr/mimir.git',
    type: 'project',
  });
  await engine.create({
    key: 'BBB',
    name: 'Beta',
    remote: 'https://github.com/dbtlr/mimir',
    type: 'project',
  });
  await engine.create({
    key: 'CCC',
    name: 'Gamma',
    remote: 'git@github.com:other/repo',
    type: 'project',
  });
  await engine.create({
    key: 'DDD',
    name: 'Delta',
    remote: 'git@github.com:dbtlr/mimir.git',
    type: 'project',
  });
  await archiveProject(fixture.store, 'DDD');

  const found = await engine.projectsByRemote({ remote: 'ssh://git@github.com/dbtlr/mimir.git' });
  expect(found.map((project) => [project.id, project.remote])).toEqual([
    ['AAA', 'github.com/dbtlr/mimir'],
    ['BBB', 'github.com/dbtlr/mimir'],
  ]);
  expect(await engine.projectsByRemote({ remote: 'https://github.com/nobody/nothing' })).toEqual(
    [],
  );
  // Input that is not a network remote (a local-path origin) matches nothing.
  for (const remote of ['not a remote', '/srv/git/r.git', 'file:///srv/git/r.git']) {
    expect(await engine.projectsByRemote({ remote })).toEqual([]);
  }
});

test('a project remote round-trips through create, update, and get', async () => {
  await engine.create({
    key: 'REM',
    name: 'Remote',
    remote: 'git@github.com:o/r.git',
    type: 'project',
  });
  expect((await engine.getNode({ id: 'REM' })).remote).toBe('github.com/o/r');
  const moved = await engine.updateProject({ id: 'REM', remote: 'https://github.com/o/moved.git' });
  expect(moved.remote).toBe('github.com/o/moved');
  expect((await engine.updateProject({ id: 'REM', remote: null })).remote).toBeNull();
  expect((await engine.getNode({ id: 'REM' })).remote).toBeNull();
  // A blank string clears the remote, as it does on create and every other transport.
  await engine.updateProject({ id: 'REM', remote: 'git@github.com:o/r.git' });
  expect((await engine.updateProject({ id: 'REM', remote: '  ' })).remote).toBeNull();
});

test('archive echoes the project and only the out-of-project tasks it freed', async () => {
  await createProject(fixture.store, { key: 'OTH', name: 'Other' });
  const initiative = await createInitiative(fixture.store, { projectId: 'OTH', title: 'Other' });
  const freed = await createTask(fixture.store, { parentId: initiative.id, title: 'freed' });
  const waiting = await createTask(fixture.store, { parentId: initiative.id, title: 'waiting' });
  const live = await createTask(fixture.store, { parentId: initiative.id, title: 'live' });
  await engine.depend({ id: freed.id, on: [id] });
  await engine.depend({ id: waiting.id, on: [id, live.id] });

  const archived = await engine.archive({ id: 'ENG' });

  expect(archived.id).toBe('ENG');
  expect(archived.archivedAt).toBeInstanceOf(Date);
  expect(archived.released).toEqual([freed.id]);
});

// Clearing long prose is explicit (ADR 0034 refinement): a blank is a refusal, `null` is the clear.
const BLANKS = ['', '   ', '\n\t '] as const;

test.each(BLANKS)('update refuses a blank direction %j and keeps the narrative', async (blank) => {
  const phase = await engine.create({ parent: 'ENG-1', title: 'Phase', type: 'phase' });
  await engine.update({ id: phase.id, next: 'Ship the store.' });
  const refusal = await errorOf(engine.update({ id: phase.id, next: blank }));
  expect(refusal.code).toBe('validation');
  expect((await engine.getNode({ facets: ['next'], id: phase.id })).next).toBe('Ship the store.');
});

test.each(BLANKS)('update refuses a blank description %j and keeps it', async (blank) => {
  await engine.update({ description: 'Open the store once.', id });
  const refusal = await errorOf(engine.update({ description: blank, id }));
  expect(refusal.code).toBe('validation');
  expect((await engine.getNode({ facets: ['description'], id })).description).toBe(
    'Open the store once.',
  );
});

test.each(BLANKS)('updateProject refuses a blank direction %j and description', async (blank) => {
  await engine.updateProject({ description: 'About.', id: 'ENG', next: 'Direction' });
  expect((await errorOf(engine.updateProject({ id: 'ENG', next: blank }))).code).toBe('validation');
  expect((await errorOf(engine.updateProject({ description: blank, id: 'ENG' }))).code).toBe(
    'validation',
  );
  const project = await engine.getNode({ facets: ['description', 'next'], id: 'ENG' });
  expect(project.next).toBe('Direction');
  expect(project.description).toBe('About.');
});

test.each(BLANKS)('seedUpdate refuses a blank description %j and keeps it', async (blank) => {
  const seed = await engine.seedCreate({
    description: 'Why it matters.',
    kind: 'idea',
    project: 'ENG',
    title: 'S',
  });
  const refusal = await errorOf(engine.seedUpdate({ description: blank, id: seed.id }));
  expect(refusal.code).toBe('validation');
  expect((await engine.getSeed({ content: true, id: seed.id })).description).toBe(
    'Why it matters.',
  );
});

test('null clears a container direction, a project direction, and every description', async () => {
  const phase = await engine.create({ parent: 'ENG-1', title: 'Phase', type: 'phase' });
  await engine.update({ description: 'Phase prose.', id: phase.id, next: 'Go.' });
  await engine.update({ description: null, id: phase.id, next: null });
  const cleared = await engine.getNode({ facets: ['description', 'next'], id: phase.id });
  expect(cleared.description).toBeNull();
  expect(cleared.next).toBeUndefined();

  await engine.updateProject({ description: 'About.', id: 'ENG', next: 'Direction' });
  await engine.updateProject({ description: null, id: 'ENG', next: null });
  const project = await engine.getNode({ facets: ['description', 'next'], id: 'ENG' });
  expect(project.description).toBeNull();
  expect(project.next).toBeUndefined();

  const seed = await engine.seedCreate({
    description: 'Why.',
    kind: 'idea',
    project: 'ENG',
    title: 'S',
  });
  expect((await engine.seedUpdate({ description: null, id: seed.id })).description).toBeNull();
});

test('clearing a direction that is absent writes nothing', async () => {
  const phase = await engine.create({ parent: 'ENG-1', title: 'Phase', type: 'phase' });
  const before = (await engine.getNode({ id: phase.id })).updatedAt;
  await Bun.sleep(20);
  await engine.update({ id: phase.id, next: null });
  expect((await engine.getNode({ id: phase.id })).updatedAt).toEqual(before);
});

test('a task refuses a direction clear as it refuses direction text', async () => {
  expect((await errorOf(engine.update({ id, next: null }))).code).toBe('validation');
});
