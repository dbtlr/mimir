import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery console page ($name)', (backend) => {
  test('assembles member status, only this delivery’s provisional decisions, follow-up items and recent journal', async () => {
    const f = await backend.make();
    try {
      const engine = new LocalEngine(f.store);
      await createProject(f.store, { key: 'DEL', name: 'Delivery' });
      const initiative = await createInitiative(f.store, { projectId: 'DEL', title: 'Plan' });
      const phase = await createPhase(f.store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(f.store, { parentId: phase.id, title: 'Member' });
      const follow = await createTask(f.store, { parentId: phase.id, title: 'Cleanup' });
      const delivery = await engine.deliveryCreate({
        phase: phase.id,
        tasks: [task.id],
        title: 'Run',
      });
      await engine.deliveryUpdate({ follow_ups: [follow.id], id: delivery.id });
      await engine.itemAdd({ content: 'Remove fixture', task: follow.id });
      const decide = (question: string, id?: string) =>
        engine.decide({
          class: 'other',
          delivery: id,
          options: ['Yes', 'No'],
          project: 'DEL',
          question,
          recommended: 1,
        });
      const open = await decide('Proceed?', delivery.id);
      const confirmed = await decide('Settled?', delivery.id);
      await engine.confirm({ id: confirmed.id });
      const other = await engine.deliveryCreate({ phase: phase.id, title: 'Other run' });
      await decide('Elsewhere?', other.id);
      let pad = await engine.scratchCreate({
        anchors: [delivery.id],
        project: 'DEL',
        title: 'Run journal',
      });
      for (let i = 1; i <= 6; i += 1) {
        pad = await engine.scratchCheckpoint({
          content: `Entry ${String(i)}`,
          expectedUpdatedAt: pad.updatedAt,
          id: pad.id,
        });
      }
      const abandoned = await engine.deliveryCreate({ phase: phase.id, title: 'Abandoned' });
      await engine.deliveryAbandon({ id: abandoned.id, reason: 'Superseded' });
      const landingTask = await createTask(f.store, { parentId: phase.id, title: 'Land me' });
      const landed = await engine.deliveryCreate({
        agreement: 'Ship',
        phase: phase.id,
        tasks: [landingTask.id],
        title: 'Landed',
      });
      await engine.deliveryStart({ id: landed.id });
      await engine.start({ harness: 'test', id: landingTask.id, session: 'test' });
      await engine.submit({ id: landingTask.id });
      await engine.stage({ id: landingTask.id });
      await engine.deliverySubmit({ id: landed.id });
      await engine.deliveryLand({ id: landed.id });
      const live = await engine.console.phaseDeliveries({ id: phase.id });
      expect(live.map((row) => row.delivery.id)).toEqual([delivery.id, other.id]);
      let loads = 0;
      const load = f.store.loadWorkingSet.bind(f.store);
      f.store.loadWorkingSet = () => {
        loads += 1;
        return load();
      };
      const page = await engine.console.deliveryPage({ id: delivery.id });
      expect(page.members.map((row) => [row.id, row.status])).toEqual([[task.id, 'ready']]);
      expect(page.decisions.map((row) => row.id)).toEqual([open.id]);
      expect(page.followUps[0]?.items.map((item) => item.content)).toEqual(['Remove fixture']);
      expect(page.phase.title).toBe('Phase');
      expect(loads).toBe(1);
      expect(page.journal.map((entry) => entry.content)).toEqual([
        'Entry 6',
        'Entry 5',
        'Entry 4',
        'Entry 3',
        'Entry 2',
      ]);
      expect(page.delivery.journal.scratchpad).toBe(pad.id);
    } finally {
      await f.close();
    }
  });
});
