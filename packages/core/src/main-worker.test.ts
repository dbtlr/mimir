import { describe, expect, test } from 'bun:test';

import { LocalEngine } from './engine';
import { createPgliteTestStore } from './store-postgres/testing';
import { refusalOf, withoutStamp } from './testing/conformance';
import { expectMimirError } from './testing/errors';
import { createTestStore, rawPatchNode } from './testing/store';

describe.each([
  ['SQLite', createTestStore],
  ['Postgres', createPgliteTestStore],
] as const)('%s main and worker ownership', (_label, createStore) => {
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
      await engine.update({ id: task.id, workerSession: 'second' });
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
        worker_harness: 'claude',
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
  test('version seven transfers retain identities and assignments while versions one through six default workers to null', async () => {
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
      const document = await fixture.store.export();
      expect(document.schema_version).toBe(7);
      const target = await createStore();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }
      for (const version of [1, 2, 3, 4, 5, 6]) {
        const legacyTarget = await createStore();
        try {
          const legacy = {
            ...document,
            nodes: document.nodes.map(
              ({ worker_harness: _h, worker_session: _s, ...node }) => node,
            ),
            schema_version: version,
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
      }
      for (const bad of [
        { worker_harness: 'claude', worker_session: null },
        { session: null, worker_harness: null, worker_session: 'worker' },
        { worker_harness: null, worker_session: ' ' },
      ]) {
        const invalid = structuredClone(document);
        const invalidNode = invalid.nodes.find((n) => n.id === task.id);
        if (invalidNode === undefined) {
          throw new Error('task missing from export');
        }
        Object.assign(invalidNode, bad);
        const invalidTarget = await createStore();
        try {
          const before = withoutStamp(await invalidTarget.store.export());
          await expectMimirError('validation', () =>
            invalidTarget.store.import(invalid, { dryRun: false, mode: 'fresh' }),
          );
          expect(withoutStamp(await invalidTarget.store.export())).toEqual(before);
        } finally {
          await invalidTarget.close();
        }
      }
    } finally {
      await fixture.close();
    }
  });
  test('transfer rejects seed and project assignment rows before writing', async () => {
    const fixture = await createStore();
    try {
      const engine = new LocalEngine(fixture.store);
      await engine.create({ key: 'OWN', name: 'Ownership', type: 'project' });
      const document = await fixture.store.export();
      const target = await createStore();
      try {
        const before = withoutStamp(await target.store.export());
        expect(
          await refusalOf(
            target.store.import(
              {
                ...document,
                transitions: [
                  {
                    at: 't',
                    from_value: '{}',
                    kind: 'assignment',
                    project_id: 'OWN',
                    to_value: '{}',
                  },
                ],
              },
              { dryRun: false, mode: 'fresh' },
            ),
          ),
        ).toContain('assignment transition must reference a node');
        expect(
          await refusalOf(
            target.store.import(
              {
                ...document,
                seeds: [
                  {
                    created_at: 't',
                    description: null,
                    history: [{ at: 't', from: '{}', kind: 'assignment', reason: null, to: '{}' }],
                    key: 'OWN',
                    kind: 'idea',
                    lifecycle: 'new',
                    requester: null,
                    seq: 1,
                    spawned: [],
                    title: 'seed',
                    updated_at: 't',
                  },
                ],
              },
              { dryRun: false, mode: 'fresh' },
            ),
          ),
        ).toContain('seeds.0.history.0.kind');
        expect(withoutStamp(await target.store.export())).toEqual(before);
      } finally {
        await target.close();
      }
    } finally {
      await fixture.close();
    }
  });
});
