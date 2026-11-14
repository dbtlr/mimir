import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { encodeDelivery } from '@mimir/contract';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import {
  updateNode,
  queueTask,
  moveNode,
  abandonTask,
  startTask,
  submitTask,
  stageTask,
  returnTask,
} from './mutations';
import type { Store } from './store';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('membership ($name)', (backend) => {
  test('sweep reserves tasks, leave releases them, and membership has its own ordered log', async () => {
    const instance = await backend.make();
    try {
      const store = instance.store;
      await createProject(store, { key: 'MEM', name: 'Members' });
      const initiative = await createInitiative(store, { projectId: 'MEM', title: 'Plan' });
      const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(store, { parentId: phase.id, title: 'Task' });
      const engine = new LocalEngine(store);
      const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
      expect((await store.loadWorkingSet()).nodes.find((n) => n.id === task.id)?.delivery).toBe(
        delivery.id,
      );
      expect(await refusalOf(queueTask(store, task.id, { session: 'reserved' }))).toContain(
        '--delivery none',
      );
      expect(await refusalOf(moveNode(store, task.id, phase.id))).toContain('--delivery none');
      await updateNode(store, task.id, { delivery: null });
      expect(await refusalOf(updateNode(store, task.id, { delivery: null }))).toContain(
        'not a member',
      );
      await updateNode(store, task.id, { delivery: delivery.id });
      await startTask(store, task.id);
      await submitTask(store, task.id);
      await stageTask(store, task.id);
      expect(await refusalOf(updateNode(store, task.id, { delivery: null }))).toContain('return');
      expect(await refusalOf(abandonTask(store, task.id))).toContain('return');
      expect(
        (await engine.getDelivery({ id: delivery.id })).history.map((r) => r.to_value),
      ).toEqual(['joined', 'left', 'joined']);
    } finally {
      await instance.close();
    }
  });
});

describe.each(backends)('membership eligibility ($name)', (backend) => {
  test('explicit selection is atomic, join refuses claimed or foreign work, and abandon records membership', async () => {
    const instance = await backend.make();
    const target = await backend.make();
    try {
      const store = instance.store;
      const engine = new LocalEngine(store);
      await createProject(store, { key: 'MEM', name: 'Members' });
      const initiative = await createInitiative(store, { projectId: 'MEM', title: 'Plan' });
      const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase' });
      const other = await createPhase(store, { parentId: initiative.id, title: 'Other' });
      const task = await createTask(store, { parentId: phase.id, title: 'Task' });
      const queued = await createTask(store, { parentId: phase.id, title: 'Queued' });
      await queueTask(store, queued.id, { session: 'reservation' });
      expect(
        await refusalOf(
          engine.deliveryCreate({ phase: phase.id, tasks: [task.id, queued.id], title: 'Bad' }),
        ),
      ).toContain('unqueued');
      expect(await engine.deliveries({ project: 'MEM' })).toEqual([]);
      const delivery = await engine.deliveryCreate({
        phase: phase.id,
        tasks: [task.id],
        title: 'Selected',
      });
      expect(delivery.members).toEqual([task.id]);
      expect(await refusalOf(updateNode(store, queued.id, { delivery: delivery.id }))).toContain(
        'unqueued',
      );
      expect(await refusalOf(updateNode(store, task.id, { delivery: delivery.id }))).toContain(
        'already a member',
      );
      const foreign = await createTask(store, { parentId: other.id, title: 'Foreign' });
      expect(await refusalOf(updateNode(store, foreign.id, { delivery: delivery.id }))).toContain(
        'phase',
      );
      expect(await refusalOf(updateNode(store, phase.id, { delivery: delivery.id }))).toContain(
        'only to tasks',
      );
      const document = await store.export();
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(
        (await new LocalEngine(target.store).getDelivery({ id: delivery.id })).members,
      ).toEqual([task.id]);
      await abandonTask(store, task.id);
      expect(
        (await store.loadWorkingSet()).nodes.find((n) => n.id === task.id)?.delivery,
      ).toBeNull();
      expect(
        (await engine.getDelivery({ id: delivery.id })).history.map((r) => r.to_value),
      ).toEqual(['joined', 'abandoned']);
    } finally {
      await instance.close();
      await target.close();
    }
  });
});

describe.each(backends)('ended delivery references ($name)', (backend) => {
  test('terminal references cannot leave or join and reopen clears a landed reference', async () => {
    const source = await backend.make();
    const target = await backend.make();
    try {
      await createProject(source.store, { key: 'MEM', name: 'Members' });
      const initiative = await createInitiative(source.store, { projectId: 'MEM', title: 'Plan' });
      const phase = await createPhase(source.store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(source.store, { parentId: phase.id, title: 'Task' });
      const engine = new LocalEngine(source.store);
      const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
      const document = structuredClone(await source.store.export());
      const record = document.deliveries[0];
      const node = document.nodes.find((n) => n.id === task.id);
      if (!record || !node) {
        throw new Error('missing fixture');
      }
      record.lifecycle = 'landed';
      node.lifecycle = 'done';
      node.rank = null;
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(await refusalOf(updateNode(target.store, task.id, { delivery: null }))).toContain(
        'not a member',
      );
      expect(
        await refusalOf(updateNode(target.store, task.id, { delivery: delivery.id })),
      ).toContain('terminal');
      const restored = new LocalEngine(target.store);
      await restored.reopen({ id: task.id });
      expect(
        (await target.store.loadWorkingSet()).nodes.find((n) => n.id === task.id)?.delivery,
      ).toBeNull();
      expect(encodeDelivery(await restored.getDelivery({ id: delivery.id })).history).toEqual(
        record.history,
      );
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe.each(backends)('join lifecycle ($name)', (backend) => {
  test.each(['queued', 'in_progress', 'under_review', 'staged', 'done', 'abandoned'] as const)(
    '%s work cannot join',
    async (lifecycle) => {
      const instance = await backend.make();
      try {
        const store = instance.store;
        const engine = new LocalEngine(store);
        await createProject(store, { key: 'MEM', name: 'Members' });
        const root = await createInitiative(store, { projectId: 'MEM', title: 'Plan' });
        const phase = await createPhase(store, { parentId: root.id, title: 'Phase' });
        const task = await createTask(store, { parentId: phase.id, title: 'Task' });
        const delivery = await engine.deliveryCreate({
          phase: phase.id,
          tasks: [],
          title: 'Attempt',
        });
        if (lifecycle === 'queued') {
          await queueTask(store, task.id, { session: 'reservation' });
        } else if (lifecycle === 'done') {
          await engine.done({ id: task.id });
        } else if (lifecycle === 'abandoned') {
          await abandonTask(store, task.id);
        } else {
          await startTask(store, task.id);
          if (lifecycle === 'under_review' || lifecycle === 'staged') {
            await submitTask(store, task.id);
          }
          if (lifecycle === 'staged') {
            await stageTask(store, task.id);
          }
        }
        const before = await store.export();
        expect(await refusalOf(updateNode(store, task.id, { delivery: delivery.id }))).toContain(
          'unqueued todo',
        );
        const after = await store.export();
        expect(after.nodes).toEqual(before.nodes);
        expect(after.transitions).toEqual(before.transitions);
        expect((await engine.getDelivery({ id: delivery.id })).history).toEqual([]);
      } finally {
        await instance.close();
      }
    },
  );
});

describe.each(backends)('held membership ($name)', (backend) => {
  test.each(['blocked', 'parked'] as const)(
    '%s todo work joins and keeps its hold when leaving',
    async (hold) => {
      const instance = await backend.make();
      try {
        const store = instance.store;
        const engine = new LocalEngine(store);
        await createProject(store, { key: 'MEM', name: 'Members' });
        const root = await createInitiative(store, { projectId: 'MEM', title: 'Plan' });
        const phase = await createPhase(store, { parentId: root.id, title: 'Phase' });
        const task = await createTask(store, { parentId: phase.id, title: 'Task' });
        if (hold === 'blocked') {
          await engine.block({ id: task.id, reason: 'Wait' });
        } else {
          await engine.park({ id: task.id, reason: 'Wait' });
        }
        const before = await store.export();
        const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
        expect(delivery.members).toEqual([task.id]);
        await updateNode(store, task.id, { delivery: null });
        const after = await store.export();
        expect(after.transitions).toEqual(before.transitions);
        expect(after.nodes.find((node) => node.id === task.id)).toMatchObject({
          delivery: null,
          hold,
          hold_reason: 'Wait',
        });
      } finally {
        await instance.close();
      }
    },
  );
});

/** The node a store holds, read through the seam. */
async function nodeOf(store: Store, id: string) {
  return (await store.loadWorkingSet()).nodes.find((n) => n.id === id);
}

/** A project with a phase of tasks, ready for a delivery. */
async function phaseOfTasks(store: Store, titles: readonly string[]) {
  await createProject(store, { key: 'MEM', name: 'Members' });
  const root = await createInitiative(store, { projectId: 'MEM', title: 'Plan' });
  const phase = await createPhase(store, { parentId: root.id, title: 'Phase' });
  const tasks: string[] = [];
  for (const title of titles) {
    tasks.push((await createTask(store, { parentId: phase.id, title })).id);
  }
  return { phase: phase.id, root: root.id, tasks };
}

describe.each(backends)('membership stamps ($name)', (backend) => {
  test('join, leave, and abandon stamp both the task and the delivery', async () => {
    const instance = await backend.make();
    try {
      const store = instance.store;
      const engine = new LocalEngine(store);
      const {
        phase,
        tasks: [task = ''],
      } = await phaseOfTasks(store, ['Task']);
      const delivery = await engine.deliveryCreate({ phase, tasks: [], title: 'Attempt' });
      const stamps = async () => ({
        delivery: encodeDelivery(await engine.getDelivery({ id: delivery.id })).updated_at,
        task: (await nodeOf(store, task))?.updated_at,
      });
      setSystemTime(new Date('2027-01-01T09:00:00Z'));
      await updateNode(store, task, { delivery: delivery.id });
      expect(await stamps()).toEqual({
        delivery: '2027-01-01T09:00:00.000Z',
        task: '2027-01-01T09:00:00.000Z',
      });
      setSystemTime(new Date('2027-01-02T09:00:00Z'));
      await updateNode(store, task, { delivery: null });
      expect(await stamps()).toEqual({
        delivery: '2027-01-02T09:00:00.000Z',
        task: '2027-01-02T09:00:00.000Z',
      });
      await updateNode(store, task, { delivery: delivery.id });
      setSystemTime(new Date('2027-01-03T09:00:00Z'));
      await abandonTask(store, task);
      expect((await stamps()).delivery).toBe('2027-01-03T09:00:00.000Z');
    } finally {
      setSystemTime();
      await instance.close();
    }
  });
});

describe.each(backends)('ending a member ($name)', (backend) => {
  test('done refuses a member and names leaving, and a task that left can be done', async () => {
    const instance = await backend.make();
    try {
      const store = instance.store;
      const engine = new LocalEngine(store);
      const {
        phase,
        tasks: [task = ''],
      } = await phaseOfTasks(store, ['Task']);
      const delivery = await engine.deliveryCreate({ phase, title: 'Attempt' });
      await startTask(store, task);
      await submitTask(store, task);
      await stageTask(store, task);
      const before = await store.export();
      const refusal = await refusalOf(engine.done({ id: task }));
      expect(refusal).toContain('lands');
      expect(refusal).toContain(`update ${task} --delivery none`);
      const after = await store.export();
      expect(after.nodes).toEqual(before.nodes);
      expect(after.transitions).toEqual(before.transitions);
      await returnTask(store, task);
      await updateNode(store, task, { delivery: null });
      await engine.done({ id: task });
      expect(await nodeOf(store, task)).toMatchObject({ delivery: null, lifecycle: 'done' });
      expect(
        (await engine.getDelivery({ id: delivery.id })).history.map((r) => r.to_value),
      ).toEqual(['joined', 'left']);
    } finally {
      await instance.close();
    }
  });
});
