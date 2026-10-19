import { describe, expect, setSystemTime, test } from 'bun:test';

import { engineSchemas } from '@mimir/contract';

import { createInitiative, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { workPageOf } from './intent';
import { queueTask, unqueueTask } from './mutations';
import { interpret, taskStatus } from './status';
import { createPgliteTestStore } from './store-postgres/testing';
import { expectMimirError } from './testing/errors';
import { createTestStore } from './testing/store';

describe.each([
  ['SQLite', createTestStore],
  ['Postgres', createPgliteTestStore],
] as const)('%s queue lifecycle', (label, createStore) => {
  test(`${label}: queued updates keep a resumable run session`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'QUE', name: 'Queue', type: 'project' });
      const parent = await engine.create({ parent: 'QUE', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ id: task.id, session: 'run' });
      for (const session of [null, '', '  ']) {
        await expectMimirError('validation', () => engine.update({ id: task.id, session }));
        expect((await engine.getNode({ id: task.id })).session).toBe('run');
      }
      await engine.update({ id: task.id, session: 'replacement-run', title: 'still reserved' });
      expect((await engine.getNode({ id: task.id })).session).toBe('replacement-run');
      await engine.start({ id: task.id });
      await engine.update({ id: task.id, session: null });
      expect((await engine.getNode({ id: task.id })).session).toBeNull();
    } finally {
      await fixture.close();
    }
  });
  test(`${label}: held work cannot be reserved and refusals leave its state intact`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'QUE', name: 'Queue', type: 'project' });
      const parent = await engine.create({ parent: 'QUE', title: 'i', type: 'initiative' });
      for (const verb of ['park', 'block'] as const) {
        const task = await engine.create({ parent: parent.id, title: verb, type: 'task' });
        await engine[verb]({ id: task.id, reason: 'on hold' });
        await expectMimirError('validation', () => engine.queue({ id: task.id, session: 'run' }));
        const held = await engine.getNode({ facets: ['history'], id: task.id });
        expect(held.lifecycle).toBe('todo');
        expect(held.hold).toBe(verb === 'park' ? 'parked' : 'blocked');
        expect(held.history).toHaveLength(1);
      }
    } finally {
      await fixture.close();
    }
  });
  test(`${label}: Now keeps the reservation time after later task edits`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'QUE', name: 'Queue', type: 'project' });
      const parent = await engine.create({ parent: 'QUE', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      setSystemTime(new Date('2026-10-19T12:00:00Z'));
      await engine.queue({ id: task.id, session: 'run' });
      setSystemTime(new Date('2026-10-19T12:10:00Z'));
      await engine.update({ id: task.id, title: 'renamed' });
      const page = await workPageOf(fixture.store, 'QUE', { timeZone: 'UTC' });
      expect(page.now[0]?.startedAt).toBe('2026-10-19T12:00:00.000Z');
    } finally {
      setSystemTime();
      await fixture.close();
    }
  });
  test(`${label}: queue records a reservation and start preserves main identity`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await createProject(fixture.store, { key: 'QUE', name: 'Queue' });
      const parent = await createInitiative(fixture.store, { projectId: 'QUE', title: 'i' });
      const task = await createTask(fixture.store, { parentId: parent.id, title: 't' });
      const queued = await engine.queue({
        branch: 'run-branch',
        harness: 'orchestrator',
        host: 'run-host',
        id: task.id,
        session: ' run ',
      });
      expect(queued.status).toBe('queued');
      expect(queued.session).toBe('run');
      const started = await engine.start({
        id: task.id,
        workerHarness: 'codex',
        workerSession: 'worker',
      });
      expect(started.lifecycle).toBe('in_progress');
      expect(started.session).toBe('run');
      expect(started.workerSession).toBe('worker');
      expect(started.harness).toBe('orchestrator');
      expect(started.workerHarness).toBe('codex');
      expect(started.host).toBeNull();
      expect(started.branch).toBeNull();
      const history = await fixture.store.bodySections.readHistory(task.id);
      expect(history.map((h) => [h.from, h.to, h.handles])).toEqual([
        [
          'todo',
          'queued',
          { branch: 'run-branch', harness: 'orchestrator', host: 'run-host', session: 'run' },
        ],
        [
          'queued',
          'in_progress',
          {
            harness: 'orchestrator',
            session: 'run',
            worker_harness: 'codex',
            worker_session: 'worker',
          },
        ],
      ]);
    } finally {
      await fixture.close();
    }
  });
  test(`${label}: unqueue restores the old next position and queued work stays visible and stale`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await createProject(fixture.store, { key: 'QUE', name: 'Queue' });
      const parent = await createInitiative(fixture.store, { projectId: 'QUE', title: 'i' });
      const task = await createTask(fixture.store, { parentId: parent.id, title: 'first' });
      const second = await createTask(fixture.store, { parentId: parent.id, title: 'second' });
      await engine.queue({ harness: 'loom', id: task.id, session: 'run' });
      expect((await engine.next({ project: 'QUE' })).items.map((n) => n.id)).toEqual([second.id]);
      expect(
        (await engine.list({ project: 'QUE', status: ['queued'] })).items.map((n) => n.id),
      ).toContain(task.id);
      const overview = await engine.overview({
        asOf: new Date('2100-01-01T00:00:00.000Z'),
        project: 'QUE',
      });
      expect(overview.next.tasks.map((n) => n.id)).toEqual([second.id]);
      expect(overview.hygiene.listings.stale.map((r) => r.task.id)).toContain(task.id);
      const page = await workPageOf(fixture.store, 'QUE', { timeZone: 'UTC' });
      expect(page.now.map((r) => r.task.id)).toContain(task.id);
      expect(overview.inFlight.tasks.map((n) => n.id)).toContain(task.id);
      const released = await engine.unqueue({ id: task.id, reason: 'run cancelled' });
      expect(released.status).toBe('ready');
      expect(released.session).toBeNull();
      expect((await engine.next({ project: 'QUE' })).items.map((n) => n.id)).toEqual([
        task.id,
        second.id,
      ]);
      expect((await fixture.store.bodySections.readHistory(task.id)).at(-1)).toMatchObject({
        from: 'queued',
        handles: { harness: 'loom', session: 'run' },
        reason: 'run cancelled',
        to: 'todo',
      });
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: transfer preview and apply refuse ownerless reservations without writing`, async () => {
    const source = await createStore();
    const target = await createStore();
    try {
      const engine = new LocalEngine(source.store);
      await engine.create({ key: 'QUE', name: 'Queue', type: 'project' });
      const parent = await engine.create({ parent: 'QUE', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ id: task.id, session: 'run' });
      const document = await source.store.export();
      const before = await target.store.export();
      for (const session of [null, '', '  ']) {
        const malformed = structuredClone(document);
        const queued = malformed.nodes.find((n) => n.id === task.id);
        if (queued === undefined) {
          throw new Error('fixture has no queued task');
        }
        queued.session = session;
        for (const dryRun of [true, false]) {
          await expectMimirError('validation', () =>
            target.store.import(malformed, { dryRun, mode: 'fresh' }),
          );
          const after = await target.store.export();
          expect({ ...after, exported_at: before.exported_at }).toEqual(before);
        }
      }
    } finally {
      await source.close();
      await target.close();
    }
  });
  test(`${label}: version-6 transfers preserve queued reservations and version-5 remains readable`, async () => {
    const source = await createStore();
    const target = await createStore();
    const legacy = await createStore();
    try {
      const engine = new LocalEngine(source.store);
      await createProject(source.store, { key: 'QUE', name: 'Queue' });
      const parent = await createInitiative(source.store, { projectId: 'QUE', title: 'i' });
      const task = await createTask(source.store, { parentId: parent.id, title: 't' });
      const previous = await source.store.export();
      await legacy.store.import(
        { ...previous, schema_version: 5 },
        { dryRun: false, mode: 'fresh' },
      );
      expect((await legacy.store.export()).schema_version).toBe(7);
      await engine.queue({ harness: 'loom', id: task.id, session: 'run' });
      const document = await source.store.export();
      expect(document.schema_version).toBe(7);
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const imported = await new LocalEngine(target.store).getNode({ id: task.id });
      expect(imported.status).toBe('queued');
      expect(imported.session).toBe('run');
      expect(await target.store.bodySections.readHistory(task.id)).toEqual(
        await source.store.bodySections.readHistory(task.id),
      );
    } finally {
      await source.close();
      await target.close();
      await legacy.close();
    }
  });

  test(`${label}: queue has a single winner and refusal leaves the reservation intact`, async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await createProject(fixture.store, { key: 'QUE', name: 'Queue' });
      const parent = await createInitiative(fixture.store, { projectId: 'QUE', title: 'i' });
      const task = await createTask(fixture.store, { parentId: parent.id, title: 't' });
      await expectMimirError('validation', () => queueTask(fixture.store, task.id));
      await expectMimirError('validation', () => engine.queue({ id: task.id, session: '  ' }));
      const first = engine.queue({ id: task.id, session: 'run-a' });
      // PGlite owns one session and cannot overlap transactions; the real-server
      // integration lane proves the Postgres race. SQLite serializes writers here.
      if (label === 'Postgres') {
        await first;
      }
      const raced = await Promise.allSettled([
        first,
        engine.queue({ id: task.id, session: 'run-b' }),
      ]);
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expectMimirError('validation', () => engine.park({ id: task.id }));
      await expectMimirError('validation', () => engine.block({ id: task.id }));
      await expectMimirError('validation', () => unqueueTask(fixture.store, task.id));
      await expectMimirError('validation', () => engine.unqueue({ id: task.id, reason: '  ' }));
      expect(await fixture.store.bodySections.readHistory(task.id)).toHaveLength(1);
      expect((await engine.getNode({ id: task.id })).status).toBe('queued');
      await engine.reorder({ id: task.id, position: 'bottom' });
      await engine.done({ id: task.id });
      expect((await engine.getNode({ id: task.id })).session).toBeNull();
      const another = await createTask(fixture.store, { parentId: parent.id, title: 'abandoned' });
      await engine.queue({ id: another.id, session: 'run' });
      expect((await engine.abandon({ id: another.id, reason: 'cancelled' })).lifecycle).toBe(
        'abandoned',
      );
    } finally {
      await fixture.close();
    }
  });
});

test('queue and unqueue schemas require session and reason', () => {
  expect(engineSchemas.queue.input.safeParse({ id: 'QUE-1' }).success).toBe(false);
  expect(engineSchemas.queue.input.safeParse({ id: 'QUE-1', session: null }).success).toBe(false);
  expect(engineSchemas.unqueue.input.safeParse({ id: 'QUE-1' }).success).toBe(false);
});

test('status precedence is in_progress > under_review > queued > awaiting > ready', () => {
  expect(taskStatus({ awaiting: true, hold: 'none', lifecycle: 'queued' })).toBe('queued');
  expect(interpret({ awaiting: 1, in_progress: 1, queued: 1, ready: 1, under_review: 1 })).toBe(
    'in_progress',
  );
  expect(interpret({ awaiting: 1, queued: 1, ready: 1, under_review: 1 })).toBe('under_review');
  expect(interpret({ awaiting: 1, queued: 1, ready: 1 })).toBe('queued');
  expect(interpret({ awaiting: 1, ready: 1 })).toBe('awaiting');
});
