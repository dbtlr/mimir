import { describe, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
import { createInitiative, createPhase, createProject, createTask, LocalEngine } from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';

import { createEngineView, createEngineViews } from './engine-view';
import type { ViewSchemas } from './engine-view';
import { createNotifier } from './notifier';
import type { Actor, MutationMarks } from './notifier';

/** Marks that record the order of what a view tells the notifier. */
function recorder() {
  const told: string[] = [];
  const marks: MutationMarks = {
    began: (actor) => void told.push(`began:${actor}`),
    failed: (actor) => void told.push(`failed:${actor}`),
    succeeded: (actor) => void told.push(`succeeded:${actor}`),
  };
  return { marks, told };
}

/** A stand-in Engine whose methods answer from a table and keep their `this`. */
function fakeEngine(answers: Record<string, () => Promise<unknown>>) {
  const engine = {
    console: {
      review: () => answers.review!(),
      task: () => answers.consoleTask!(),
    },
    create: () => answers.create!(),
    getNode: () => answers.getNode!(),
    overturn: () => answers.overturn!(),
  };
  return engine as unknown as Engine;
}

describe('an Engine view', () => {
  test('a mutation is marked began, then succeeded, and returns the Engine result untouched', async () => {
    const result = { id: 'MMR-1' };
    const { marks, told } = recorder();
    const view = createEngineView(fakeEngine({ create: async () => result }), 'other', marks);
    const answered: unknown = await view.create({ key: 'MMR', name: 'x', type: 'project' });
    expect(answered).toBe(result);
    expect(told).toEqual(['began:other', 'succeeded:other']);
  });

  test('a mutation that fails is marked failed and rejects with its own error', async () => {
    const refusal = new MimirError('not_found', 'MMR-9 does not exist');
    const { marks, told } = recorder();
    const view = createEngineView(
      fakeEngine({
        overturn: async () => {
          throw refusal;
        },
      }),
      'operator',
      marks,
    );
    const outcome = await view.overturn({ id: 'MMR-q9' }).catch((error: unknown) => error);
    expect(outcome).toBe(refusal);
    expect(told).toEqual(['began:operator', 'failed:operator']);
  });

  test('a query tells the notifier nothing', async () => {
    const { marks, told } = recorder();
    const view = createEngineView(
      fakeEngine({ getNode: async () => ({}), review: async () => ({}) }),
      'other',
      marks,
    );
    await view.getNode({ id: 'MMR-1' });
    await view.console.review({ timeZone: 'UTC' });
    expect(told).toEqual([]);
  });

  test('a notifier that throws never changes the write result or error', async () => {
    const throwing: MutationMarks = {
      began: () => {
        throw new Error('notifier fault');
      },
      failed: () => {
        throw new Error('notifier fault');
      },
      succeeded: () => {
        throw new Error('notifier fault');
      },
    };
    const refusal = new Error('write refused');
    const ok = createEngineView(fakeEngine({ create: async () => 'made' }), 'other', throwing);
    const made: unknown = await ok.create({ key: 'MMR', name: 'x', type: 'project' });
    expect(made).toBe('made');
    const bad = createEngineView(
      fakeEngine({
        create: async () => {
          throw refusal;
        },
      }),
      'other',
      throwing,
    );
    expect(
      await bad.create({ key: 'MMR', name: 'x', type: 'project' }).catch((e: unknown) => e),
    ).toBe(refusal);
  });
});

describe('the views by consumer', () => {
  test.each([
    ['console', 'operator'],
    ['t3', 'operator'],
    ['trpc', 'other'],
    ['agentRuns', 'other'],
  ] as const)('a write through the %s view is the %s actor', async (consumer, actor) => {
    const { marks, told } = recorder();
    const views = createEngineViews(fakeEngine({ create: async () => ({}) }), marks);
    await views[consumer].create({ key: 'MMR', name: 'x', type: 'project' });
    expect(told).toEqual([`began:${actor}`, `succeeded:${actor}`]);
  });

  test('each actor has one view, shared by its consumers', () => {
    const views = createEngineViews(fakeEngine({}), recorder().marks);
    expect(views.t3).toBe(views.console);
    expect(views.agentRuns).toBe(views.trpc);
    expect(views.console).not.toBe(views.trpc);
  });
});

describe('a namespace of the Engine', () => {
  test('a mutation in a nested namespace is marked, and a query in it is not', async () => {
    const engine = {
      extra: { change: async () => 'changed', look: async () => 'looked' },
    } as unknown as Engine;
    const { marks, told } = recorder();
    const view = createEngineView(engine, 'other', marks, {
      flat: {},
      namespaces: {
        extra: { change: { kind: 'mutation' }, look: { kind: 'query' } },
        // The map is typed for the contract's namespaces; a test names its own.
      } as unknown as ViewSchemas['namespaces'],
    });
    const nested = (view as unknown as { extra: Record<string, () => Promise<string>> }).extra;
    expect(await nested.look!()).toBe('looked');
    expect(told).toEqual([]);
    expect(await nested.change!()).toBe('changed');
    expect(told).toEqual(['began:other', 'succeeded:other']);
  });
});

describe('views over a real Engine', () => {
  test('a write through each view is withheld or reported by who made it', async () => {
    const fixture = await createTestStore();
    try {
      const { store } = fixture;
      await createProject(store, { key: 'VEW', name: 'View' });
      const initiative = await createInitiative(store, { projectId: 'VEW', title: 'Plan' });
      const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase' });
      const first = await createTask(store, { parentId: phase.id, title: 'First' });
      const second = await createTask(store, { parentId: phase.id, title: 'Second' });
      const engine = new LocalEngine(store);
      let time = 1;
      const timers: (() => void)[] = [];
      const logs: string[] = [];
      const notifier = createNotifier({
        channels: [],
        clearTimer: () => {},
        log: (line) => void logs.push(line),
        monotonicNow: () => time++,
        reads: {
          deliveryTitle: async (id) => (await engine.getDelivery({ id })).title,
          review: (input) => engine.console.review(input),
        },
        setTimer: (run) => timers.push(run),
        wallNow: () => 0,
      });
      await notifier.boot();
      const as = (actor: Actor) => createEngineView(engine, actor, notifier.marks);
      const closeWindow = async () => {
        timers.splice(0).forEach((run) => run());
        for (let turn = 0; turn < 60; turn += 1) {
          await Promise.resolve();
          await Bun.sleep(0);
        }
      };
      await as('operator').block({ id: first.id, on: 'you', reason: 'Console help' });
      await closeWindow();
      const lines = () =>
        logs.map((line) => {
          const { time: _time, ...rest } = JSON.parse(line) as { time: string };
          return rest;
        });
      expect(lines()).toEqual([{ event: 'needs_you_withheld', ids: first.id }]);
      await as('other').block({ id: second.id, on: 'you', reason: 'Agent help' });
      await closeWindow();
      expect(lines().at(-1)).toEqual({
        count: 2,
        event: 'needs_you_event',
        ids: second.id,
        kind: 'task_blocked',
        target: `/p/VEW/${second.id.split('-')[1]}`,
      });
      notifier.close();
    } finally {
      await fixture.close();
    }
  });
});
