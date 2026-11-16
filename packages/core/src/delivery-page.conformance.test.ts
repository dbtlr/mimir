import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends } from './testing/conformance';

beforeAll(bootPglite);

/** A project with one phase, a live delivery over one member, and a task to follow up on. */
async function seeded(store: Parameters<typeof createProject>[0]) {
  const engine = new LocalEngine(store);
  await createProject(store, { key: 'DEL', name: 'Delivery' });
  const initiative = await createInitiative(store, { projectId: 'DEL', title: 'Plan' });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase' });
  const task = await createTask(store, { parentId: phase.id, title: 'Member' });
  const follow = await createTask(store, { parentId: phase.id, title: 'Cleanup' });
  const delivery = await engine.deliveryCreate({
    phase: phase.id,
    tasks: [task.id],
    title: 'Run',
  });
  const decide = (question: string, id?: string) =>
    engine.decide({
      class: 'other',
      delivery: id,
      options: ['Yes', 'No'],
      project: 'DEL',
      question,
      recommended: 1,
    });
  return { decide, delivery, engine, follow, phase, task };
}

describe.each(backends)('delivery console page ($name)', (backend) => {
  test('reads each member’s derived status and its phase', async () => {
    const f = await backend.make();
    try {
      const { delivery, engine, phase, task } = await seeded(f.store);
      const page = await engine.console.deliveryPage({ id: delivery.id });
      expect(page.members.map((row) => [row.id, row.status])).toEqual([[task.id, 'ready']]);
      expect(page.phase.id).toBe(phase.id);
    } finally {
      await f.close();
    }
  });

  test('lists only this delivery’s provisional decisions', async () => {
    const f = await backend.make();
    try {
      const { decide, delivery, engine, phase } = await seeded(f.store);
      const open = await decide('Proceed?', delivery.id);
      const confirmed = await decide('Settled?', delivery.id);
      await engine.confirm({ id: confirmed.id });
      const other = await engine.deliveryCreate({ phase: phase.id, title: 'Other run' });
      await decide('Elsewhere?', other.id);
      const page = await engine.console.deliveryPage({ id: delivery.id });
      expect(page.decisions.map((row) => row.id)).toEqual([open.id]);
    } finally {
      await f.close();
    }
  });

  test('carries the checklist items of each linked follow-up task', async () => {
    const f = await backend.make();
    try {
      const { delivery, engine, follow } = await seeded(f.store);
      await engine.deliveryUpdate({ follow_ups: [follow.id], id: delivery.id });
      await engine.itemAdd({ content: 'Remove fixture', task: follow.id });
      const page = await engine.console.deliveryPage({ id: delivery.id });
      expect(page.followUps[0]?.items.map((item) => item.content)).toEqual(['Remove fixture']);
    } finally {
      await f.close();
    }
  });

  test('reads the working set once and links the run journal’s pad', async () => {
    const f = await backend.make();
    try {
      const { delivery, engine } = await seeded(f.store);
      const pad = await engine.scratchCreate({
        anchors: [delivery.id],
        project: 'DEL',
        title: 'Run journal',
      });
      await engine.scratchCheckpoint({
        content: 'Entry 1',
        expectedUpdatedAt: pad.updatedAt,
        id: pad.id,
      });
      let loads = 0;
      const load = f.store.loadWorkingSet.bind(f.store);
      f.store.loadWorkingSet = () => {
        loads += 1;
        return load();
      };
      const page = await engine.console.deliveryPage({ id: delivery.id });
      expect(loads).toBe(1);
      expect(page.delivery.journal.scratchpad).toBe(pad.id);
      expect(page.journal.map((entry) => entry.content)).toEqual(['Entry 1']);
    } finally {
      await f.close();
    }
  });

  test('lists a phase’s deliveries from the store without the abandoned', async () => {
    const f = await backend.make();
    try {
      const { delivery, engine, phase } = await seeded(f.store);
      const abandoned = await engine.deliveryCreate({ phase: phase.id, title: 'Abandoned' });
      await engine.deliveryAbandon({ id: abandoned.id, reason: 'Superseded' });
      const live = await engine.console.phaseDeliveries({ id: phase.id });
      expect(live.map((row) => row.delivery.id)).toEqual([delivery.id]);
    } finally {
      await f.close();
    }
  });
});
