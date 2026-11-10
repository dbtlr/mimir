import { describe, expect, test } from 'bun:test';

import { LocalEngine } from './engine';
import { startTask } from './mutations';
import { OPS } from './ops';
import { createPgliteTestStore } from './store-postgres/testing';
import { withoutStamp } from './testing/conformance';
import { expectMimirError } from './testing/errors';
import { createTestStore, rawPatchNode } from './testing/store';

/** A queued task reserved with a host and branch, on a fresh store. */
async function queuedWithContext() {
  const fixture = await createTestStore();
  const engine = new LocalEngine(fixture.store);
  await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
  const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
  const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
  await engine.queue({
    branch: 'reservation',
    harness: 'codex',
    host: 'queue-host',
    id: task.id,
    session: 'main',
  });
  return { engine, fixture, id: task.id };
}

// Postgres keeps the cases that read back what migration 0008 added: the
// worker columns on node, the 'assignment' kind its transition_log check
// admits, and history handles in a jsonb column.
describe.each([
  ['SQLite', createTestStore],
  ['Postgres', createPgliteTestStore],
] as const)('%s main and worker columns', (_label, createStore) => {
  test('a delegated start preserves its main conversation and records both identities', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({
        branch: 'reservation',
        harness: 'codex',
        host: 'main-host',
        id: task.id,
        session: 'main',
      });
      const started = await engine.start({
        branch: 'execution',
        id: task.id,
        workerHarness: 'claude',
        workerSession: 'worker',
      });
      expect(started).toMatchObject({
        branch: 'execution',
        harness: 'codex',
        host: null,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'worker',
      });
      expect(
        (await engine.getNode({ facets: ['history'], id: task.id })).history?.at(-1)?.handles,
      ).toEqual({
        branch: 'execution',
        harness: 'codex',
        session: 'main',
        worker_harness: 'claude',
        worker_session: 'worker',
      });
    } finally {
      await fixture.close();
    }
  });
  // The parse defaults missing worker handles whatever the document's version,
  // and transfer-schema.test.ts reads every older version through it, so one
  // legacy version is imported here. The rows the parse refuses are in
  // transfer-validate.test.ts.
  test('version seven transfers retain identities and assignments while version six defaults workers to null', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.start({
        harness: 'codex',
        id: task.id,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'first',
      });
      await engine.update({ id: task.id, workerSession: 'second' });
      // A worker on the main session stays distinct when two known providers
      // differ (MMR-568), and the import must keep its provider.
      const shared = await engine.create({ parent: parent.id, title: 'shared', type: 'task' });
      await engine.start({
        harness: 'codex',
        id: shared.id,
        session: 'same',
        workerHarness: 'claude',
        workerSession: 'same',
      });
      const document = await fixture.store.export();
      expect(document.schema_version).toBe(7);
      expect(document.nodes.find((n) => n.id === shared.id)).toMatchObject({
        session: 'same',
        worker_harness: 'claude',
        worker_session: 'same',
      });
      const target = await createStore();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }
      const legacyTarget = await createStore();
      try {
        const legacy = {
          ...document,
          nodes: document.nodes.map(({ worker_harness: _h, worker_session: _s, ...node }) => node),
          schema_version: 6,
          transitions: document.transitions.filter((t) => t.kind !== 'assignment'),
        };
        await legacyTarget.store.import(legacy, { dryRun: false, mode: 'fresh' });
        const imported = (await legacyTarget.store.export()).nodes.find((n) => n.id === task.id);
        expect(imported).toMatchObject({
          harness: 'codex',
          session: 'main',
          worker_harness: null,
          worker_session: null,
        });
      } finally {
        await legacyTarget.close();
      }
    } finally {
      await fixture.close();
    }
  });
});

// Which handles a start, an update, or a hold keeps is decided in JS
// (assignment.ts and the mutations), so these cases run on SQLite alone.
describe('SQLite main and worker ownership', () => {
  const createStore = createTestStore;
  test('Engine start refuses a stale main assignment before recording worker ownership', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ harness: 'codex', id: task.id, session: 'main' });
      const observed = await engine.getNode({ id: task.id });
      const startExpectation = {
        harness: observed.harness ?? null,
        lifecycle: observed.lifecycle ?? null,
        session: observed.session ?? null,
      };
      await engine.update({ id: task.id, session: 'replacement-main' });
      const before = withoutStamp(await fixture.store.export());
      await expectMimirError('conflict', () =>
        engine.start({ id: task.id, startExpectation, workerSession: 'worker' }),
      );
      expect(withoutStamp(await fixture.store.export())).toEqual(before);
      const current = await engine.getNode({ id: task.id });
      expect(
        await engine.start({
          id: task.id,
          startExpectation: {
            harness: current.harness ?? null,
            lifecycle: current.lifecycle ?? null,
            session: current.session ?? null,
          },
          workerSession: 'worker',
        }),
      ).toMatchObject({ session: 'replacement-main', workerSession: 'worker' });
    } finally {
      await fixture.close();
    }
  });
  test('solo starts and explicit same-agent worker input keep worker identity absent', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      const solo = await engine.start({
        harness: 'codex',
        id: task.id,
        session: 'main',
        workerHarness: 'codex',
        workerSession: 'main',
      });
      expect(solo).toMatchObject({
        harness: 'codex',
        session: 'main',
        workerHarness: null,
        workerSession: null,
      });
      expect(
        (await fixture.store.export()).nodes.find((n) => n.id === task.id)?.worker_session,
      ).toBeNull();
    } finally {
      await fixture.close();
    }
  });
  test('a session-only queued start replaces a preassigned worker without inheriting its harness', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ harness: 'codex', id: task.id, session: 'main' });
      await engine.update({ id: task.id, workerHarness: 'claude', workerSession: 'previous' });
      const started = await engine.start({ id: task.id, workerSession: 'successor' });
      expect(started).toMatchObject({
        harness: 'codex',
        session: 'main',
        workerHarness: null,
        workerSession: 'successor',
      });
      const history = (await engine.getNode({ facets: ['history'], id: task.id })).history ?? [];
      expect(history.at(-1)?.handles).toEqual({
        harness: 'codex',
        session: 'main',
        worker_session: 'successor',
      });
      expect(history.at(-2)?.handles?.worker_harness).toBe('claude');
    } finally {
      await fixture.close();
    }
  });
  test('start rejects an implicit main takeover without changing reservation or history', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ harness: 'codex', id: task.id, session: 'main' });
      const before = withoutStamp(await fixture.store.export());
      await expectMimirError('validation', () =>
        engine.start({ id: task.id, workerHarness: 'claude' }),
      );
      await expectMimirError('validation', () =>
        engine.start({ harness: 'claude', id: task.id, session: 'worker' }),
      );
      expect(withoutStamp(await fixture.store.export())).toEqual(before);
      const started = await engine.start({ harness: 'codex', id: task.id, session: 'main' });
      expect(started).toMatchObject({ harness: 'codex', session: 'main', workerSession: null });
    } finally {
      await fixture.close();
    }
  });
  test('update audits worker succession and explicit main takeover while scalar execution edits stay unlogged', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.start({
        harness: 'codex',
        id: task.id,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'first',
      });
      await engine.update({ host: 'new-host', id: task.id, title: 'renamed' });
      const successor = await engine.update({ id: task.id, workerSession: 'second' });
      expect(successor).toMatchObject({
        harness: 'codex',
        session: 'main',
        workerHarness: null,
        workerSession: 'second',
      });
      await engine.update({
        id: task.id,
        session: 'new-main',
        workerHarness: 'codex',
        workerSession: 'third',
      });
      await engine.update({ id: task.id, workerSession: null });
      const history = (await engine.getNode({ facets: ['history'], id: task.id })).history ?? [];
      expect(history.map((h) => h.kind)).toEqual([
        'lifecycle',
        'assignment',
        'assignment',
        'assignment',
      ]);
      expect(JSON.parse(history[1]?.from ?? '')).toEqual({
        harness: 'codex',
        session: 'main',
        worker_harness: 'claude',
        worker_session: 'first',
      });
      expect(JSON.parse(history[1]?.to ?? '')).toEqual({
        harness: 'codex',
        session: 'main',
        worker_harness: null,
        worker_session: 'second',
      });
      expect(history[2]?.handles).toEqual({
        harness: 'codex',
        host: 'new-host',
        session: 'new-main',
        worker_harness: 'codex',
        worker_session: 'third',
      });
      expect(await engine.getNode({ id: task.id })).toMatchObject({
        workerHarness: null,
        workerSession: null,
      });
    } finally {
      await fixture.close();
    }
  });
  test('invalid worker pairs refuse atomically and clearing a worker session clears its harness', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      for (const patch of [
        { workerHarness: 'claude' },
        { workerSession: 'worker' },
        { workerHarness: 'claude', workerSession: null },
      ]) {
        const before = withoutStamp(await fixture.store.export());
        await expectMimirError('validation', () =>
          engine.update({ id: task.id, title: 'must not change', ...patch }),
        );
        expect(withoutStamp(await fixture.store.export())).toEqual(before);
      }
      await engine.start({
        id: task.id,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'worker',
      });
      await expectMimirError('validation', () => engine.update({ id: task.id, session: null }));
      const cleared = await engine.update({ id: task.id, workerSession: '  ' });
      expect(cleared).toMatchObject({
        session: 'main',
        workerHarness: null,
        workerSession: null,
      });
    } finally {
      await fixture.close();
    }
  });
  test('hold and terminal boundaries echo every handle and resume establishes a new main assignment', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      for (const verb of ['park', 'block', 'done', 'abandon'] as const) {
        const task = await engine.create({ parent: parent.id, title: verb, type: 'task' });
        await engine.start({
          branch: 'b',
          harness: 'codex',
          host: 'h',
          id: task.id,
          session: 'main',
          workerHarness: 'claude',
          workerSession: 'worker',
        });
        const cleared = await engine[verb]({ id: task.id });
        expect(cleared).toMatchObject({
          branch: null,
          harness: null,
          host: null,
          session: null,
          workerHarness: null,
          workerSession: null,
        });
        const history = (await engine.getNode({ facets: ['history'], id: task.id })).history ?? [];
        expect(history.at(-1)?.handles).toEqual({
          branch: 'b',
          harness: 'codex',
          host: 'h',
          session: 'main',
          worker_harness: 'claude',
          worker_session: 'worker',
        });
        if (verb === 'park' || verb === 'block') {
          await engine[verb === 'park' ? 'unpark' : 'unblock']({ id: task.id });
          const resumed = await engine.update({
            harness: 'claude',
            id: task.id,
            session: 'resumed',
          });
          expect(resumed).toMatchObject({
            harness: 'claude',
            session: 'resumed',
            workerSession: null,
          });
        }
      }
    } finally {
      await fixture.close();
    }
  });
  test('a preseeded worker remains lossless in the first explicit takeover history', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await rawPatchNode(fixture.store, task.id, {
        harness: 'old · main',
        session: 'old\nmain',
        worker_harness: 'old-worker',
        worker_session: 'old\nworker',
      });
      await engine.update({
        harness: 'codex',
        id: task.id,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'worker',
      });
      const history = await fixture.store.bodySections.readHistory(task.id);
      expect(history).toHaveLength(1);
      expect(JSON.parse(history[0]?.from ?? '')).toEqual({
        harness: 'old · main',
        session: 'old\nmain',
        worker_harness: 'old-worker',
        worker_session: 'old\nworker',
      });
    } finally {
      await fixture.close();
    }
  });
  test('a worker explicitly assigned while queued survives a plain start', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({
        branch: 'reservation',
        harness: 'codex',
        host: 'queue-host',
        id: task.id,
        session: 'main',
      });
      await engine.update({ id: task.id, workerHarness: 'claude', workerSession: 'worker' });
      const started = await engine.start({ id: task.id });
      expect(started).toMatchObject({
        branch: null,
        harness: 'codex',
        host: null,
        session: 'main',
        workerHarness: 'claude',
        workerSession: 'worker',
      });
      const history = await fixture.store.bodySections.readHistory(task.id);
      expect(history.map((entry) => entry.kind)).toEqual(['lifecycle', 'assignment', 'lifecycle']);
      expect(history.at(-1)?.handles).toEqual({
        harness: 'codex',
        session: 'main',
        worker_harness: 'claude',
        worker_session: 'worker',
      });
    } finally {
      await fixture.close();
    }
  });

  describe('starting a queued task keeps its execution context unless a worker takes over', () => {
    test('a plain start with no worker keeps host and branch', async () => {
      const { engine, fixture, id } = await queuedWithContext();
      try {
        expect(await engine.start({ id })).toMatchObject({
          branch: 'reservation',
          host: 'queue-host',
          workerSession: null,
        });
      } finally {
        await fixture.close();
      }
    });

    test('a host or branch the start supplies replaces the stored one', async () => {
      const { engine, fixture, id } = await queuedWithContext();
      try {
        expect(await engine.start({ branch: 'execution', host: 'run-host', id })).toMatchObject({
          branch: 'execution',
          host: 'run-host',
        });
      } finally {
        await fixture.close();
      }
    });

    test('a start naming a distinct worker resets host and branch', async () => {
      const { engine, fixture, id } = await queuedWithContext();
      try {
        expect(
          await engine.start({ id, workerHarness: 'claude', workerSession: 'worker' }),
        ).toMatchObject({ branch: null, host: null, workerSession: 'worker' });
      } finally {
        await fixture.close();
      }
    });

    test('a worker assigned earlier by update resets host and branch on a plain start', async () => {
      const { engine, fixture, id } = await queuedWithContext();
      try {
        await engine.update({ id, workerHarness: 'claude', workerSession: 'worker' });
        expect(await engine.start({ id })).toMatchObject({
          branch: null,
          host: null,
          workerSession: 'worker',
        });
      } finally {
        await fixture.close();
      }
    });

    test('a worker input that collapses into the main session keeps host and branch', async () => {
      const { engine, fixture, id } = await queuedWithContext();
      try {
        expect(await engine.start({ id, workerSession: 'main' })).toMatchObject({
          branch: 'reservation',
          host: 'queue-host',
          workerHarness: null,
          workerSession: null,
        });
      } finally {
        await fixture.close();
      }
    });
  });

  test('same-session workers collapse when either provider is unknown and remain distinct with conflicting known providers', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      for (const handles of [
        { harness: 'codex', session: 'same', workerSession: 'same' },
        { session: 'same', workerHarness: 'claude', workerSession: 'same' },
      ]) {
        const task = await engine.create({ parent: parent.id, title: 'same agent', type: 'task' });
        expect(await engine.start({ id: task.id, ...handles })).toMatchObject({
          workerHarness: null,
          workerSession: null,
        });
      }
      const task = await engine.create({
        parent: parent.id,
        title: 'different providers',
        type: 'task',
      });
      expect(
        await engine.start({
          harness: 'codex',
          id: task.id,
          session: 'same',
          workerHarness: 'claude',
          workerSession: 'same',
        }),
      ).toMatchObject({ workerHarness: 'claude', workerSession: 'same' });
      await engine.update({ id: task.id, workerSession: 'other' });
      await engine.update({ id: task.id, workerHarness: null });
      expect(await engine.update({ id: task.id, workerSession: 'same' })).toMatchObject({
        workerHarness: null,
        workerSession: null,
      });
    } finally {
      await fixture.close();
    }
  });

  test.each(['unqueue', 'mainSession', 'mainHarness'] as const)(
    'start refuses a stale main-identity snapshot after %s without adding history',
    async (change) => {
      const fixture = await createStore();
      try {
        const engine = new LocalEngine(fixture.store);
        await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
        const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
        const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
        await engine.queue({ harness: 'codex', id: task.id, session: 'main' });
        const expectation = { harness: 'codex', lifecycle: 'queued' as const, session: 'main' };
        if (change === 'unqueue') {
          await engine.unqueue({ id: task.id, reason: 'cancelled while caller read state' });
        } else if (change === 'mainSession') {
          await engine.update({ id: task.id, session: 'replacement' });
        } else {
          await engine.update({ harness: 'claude', id: task.id });
        }
        const before = withoutStamp(await fixture.store.export());
        await expectMimirError('conflict', () =>
          startTask(fixture.store, task.id, { host: 'must not write' }, expectation),
        );
        await expectMimirError('conflict', () =>
          OPS.start.run(fixture.store, task.id, undefined, { host: 'must not write' }, undefined, {
            startExpectation: expectation,
          }),
        );
        expect(withoutStamp(await fixture.store.export())).toEqual(before);
      } finally {
        await fixture.close();
      }
    },
  );
  test('start expectations ignore unrelated edits while checking the assignment inside the transaction', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const parent = await engine.create({ parent: 'OWN', title: 'i', type: 'initiative' });
      const task = await engine.create({ parent: parent.id, title: 't', type: 'task' });
      await engine.queue({ harness: 'codex', id: task.id, session: 'main' });
      const expectation = { harness: 'codex', lifecycle: 'queued' as const, session: 'main' };
      await engine.update({ host: 'changed', id: task.id, title: 'an unrelated edit' });
      expect(await startTask(fixture.store, task.id, {}, expectation)).toMatchObject({
        harness: 'codex',
        lifecycle: 'in_progress',
        session: 'main',
        title: 'an unrelated edit',
      });
    } finally {
      await fixture.close();
    }
  });
});
