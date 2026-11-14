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

/**
 * A store holding a live delivery, a landed one, and a landed delivery in
 * another project, exported once: each reference case edits a copy of the
 * document and imports it.
 */
async function referenceFixture(store: Store) {
  const engine = new LocalEngine(store);
  const { phase, root, tasks } = await phaseOfTasks(store, ['Task']);
  const later = await createPhase(store, { parentId: root, title: 'Later' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  const otherRoot = await createInitiative(store, { projectId: 'OTH', title: 'Plan' });
  const otherPhase = await createPhase(store, { parentId: otherRoot.id, title: 'Phase' });
  const live = await engine.deliveryCreate({ phase, tasks: [], title: 'Live' });
  const landed = await engine.deliveryCreate({ phase, tasks: [], title: 'Landed' });
  const abandoned = await engine.deliveryCreate({ phase, tasks: [], title: 'Abandoned' });
  const foreign = await engine.deliveryCreate({
    phase: otherPhase.id,
    tasks: [],
    title: 'Foreign',
  });
  const document = structuredClone(await store.export());
  for (const record of document.deliveries) {
    if (record.id === landed.id || record.id === foreign.id) {
      record.lifecycle = 'landed';
    }
    if (record.id === abandoned.id) {
      record.lifecycle = 'abandoned';
    }
  }
  return {
    abandoned: abandoned.id,
    document,
    foreign: foreign.id,
    landed: landed.id,
    later: later.id,
    live: live.id,
    phase,
    task: tasks[0] ?? '',
  };
}

type Fixture = Awaited<ReturnType<typeof referenceFixture>>;
type DocNode = Fixture['document']['nodes'][number];

/** Edit the fixture's task (or another node) in a copy of the document. */
function withNode(fixture: Fixture, edit: (node: DocNode) => void, id = fixture.task) {
  const document = structuredClone(fixture.document);
  const node = document.nodes.find((n) => n.id === id);
  if (node === undefined) {
    throw new Error(`missing fixture node ${id}`);
  }
  edit(node);
  return document;
}

const finished = (lifecycle: 'done' | 'abandoned') => (node: DocNode) => {
  node.lifecycle = lifecycle;
  node.rank = null;
  node.completed_at = lifecycle === 'done' ? node.updated_at : null;
};

describe.each(backends)('delivery references on import ($name)', (backend) => {
  test('a landed task keeps its reference through a move and a second round trip', async () => {
    const source = await backend.make();
    const target = await backend.make();
    const again = await backend.make();
    try {
      const fixture = await referenceFixture(source.store);
      const document = withNode(fixture, (node) => {
        finished('done')(node);
        node.delivery = fixture.landed;
      });
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const engine = new LocalEngine(target.store);
      expect((await engine.getDelivery({ id: fixture.landed })).members).toEqual([]);
      expect(await refusalOf(updateNode(target.store, fixture.task, { delivery: null }))).toContain(
        'not a member',
      );
      await moveNode(target.store, fixture.task, fixture.later);
      await again.store.import(await target.store.export(), { dryRun: false, mode: 'fresh' });
      expect(await nodeOf(again.store, fixture.task)).toMatchObject({
        delivery: fixture.landed,
        lifecycle: 'done',
        parent_id: fixture.later,
      });
    } finally {
      await source.close();
      await target.close();
      await again.close();
    }
  });

  test('every reference state the verbs cannot produce is refused', async () => {
    const source = await backend.make();
    const target = await backend.make();
    try {
      const f = await referenceFixture(source.store);
      const at = (delivery: string, ...edits: ((node: DocNode) => void)[]) =>
        withNode(f, (node) => {
          for (const edit of edits) {
            edit(node);
          }
          node.delivery = delivery;
        });
      const cases: [string, Fixture['document'], string][] = [
        [
          'a non-task',
          withNode(f, (node) => void (node.delivery = f.live), f.phase),
          'only tasks carry delivery',
        ],
        ['a missing delivery', at('MEM-d99'), 'names a missing delivery'],
        [
          'a queued task',
          at(f.live, (node) => {
            node.lifecycle = 'queued';
            node.session = 'reservation';
          }),
          'queued',
        ],
        ['an abandoned task', at(f.live, finished('abandoned')), 'abandoned'],
        ['a live task naming a landed delivery', at(f.landed), 'non-terminal'],
        ['a live task naming an abandoned delivery', at(f.abandoned), 'non-terminal'],
        ['a done task naming a live delivery', at(f.live, finished('done')), 'landed'],
        ['a done task naming an abandoned delivery', at(f.abandoned, finished('done')), 'landed'],
        [
          'a member outside the phase',
          at(f.live, (node) => void (node.parent_id = f.later)),
          "the delivery's phase",
        ],
        ['a done task naming another project', at(f.foreign, finished('done')), 'another project'],
      ];
      for (const [name, document, fault] of cases) {
        const refusal = await refusalOf(
          target.store.import(document, { dryRun: false, mode: 'fresh' }),
        );
        expect(refusal, name).toContain(
          `${document === cases[0]?.[1] ? f.phase : f.task}.delivery`,
        );
        expect(refusal, name).toContain(fault);
      }
      // Every refusal left the target empty, so the valid member still imports.
      await target.store.import(at(f.live), { dryRun: false, mode: 'fresh' });
      expect((await new LocalEngine(target.store).getDelivery({ id: f.live })).members).toEqual([
        f.task,
      ]);
    } finally {
      await source.close();
      await target.close();
    }
  });
});
