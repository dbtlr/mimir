import { expect, test } from 'bun:test';

import { createProject, createInitiative, createPhase } from './create';
import { LocalEngine } from './engine';
import { parseIdentity, renderDeliveryRef } from './ids';
import { refusalOf } from './testing/conformance';
import { createTestStore } from './testing/store';

test('a delivery records an attempt beside its phase, and updates replace its terms', async () => {
  const fixture = await createTestStore();
  try {
    const engine = new LocalEngine(fixture.store);
    await createProject(fixture.store, { key: 'DEL', name: 'Delivery' });
    const initiative = await createInitiative(fixture.store, { projectId: 'DEL', title: 'Plan' });
    const phase = await createPhase(fixture.store, { parentId: initiative.id, title: 'Phase' });
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      project: 'DEL',
      time_cap_minutes: 15,
      title: 'Attempt',
    });
    expect(delivery.id).toBe('DEL-d1');
    expect(parseIdentity(delivery.id)).toEqual({ key: 'DEL', kind: 'delivery', seq: 1 });
    expect(renderDeliveryRef({ key: 'DEL', seq: 1 })).toBe(delivery.id);
    expect(delivery.lifecycle).toBe('agreed');
    expect(delivery.hold).toBe('none');
    expect(delivery.elapsed_minutes).toBeNull();
    expect(delivery.history).toEqual([]);
    const updated = await engine.deliveryUpdate({
      agreement: null,
      branch: 'work',
      id: delivery.id,
      time_cap_minutes: null,
    });
    expect(updated.agreement).toBeNull();
    expect(updated.time_cap_minutes).toBeNull();
    expect(await engine.getDelivery({ id: delivery.id })).toEqual(updated);
    expect(await engine.deliveries({ project: 'DEL' })).toEqual([updated]);
    expect(
      await refusalOf(
        engine.deliveryCreate({ phase: initiative.id, project: 'DEL', title: 'Invalid' }),
      ),
    ).toContain('phase');
    expect(await refusalOf(engine.start({ id: delivery.id }))).toContain('delivery');
    const exported = await fixture.store.export();
    expect(exported.projects[0]?.counters.delivery).toBe(1);
    const target = await createTestStore();
    try {
      await target.store.import(exported, { dryRun: false, mode: 'fresh' });
      expect(await new LocalEngine(target.store).getDelivery({ id: delivery.id })).toEqual(updated);
    } finally {
      await target.close();
    }
    await engine.archive({ id: 'DEL' });
    expect(await engine.deliveries({ project: 'DEL' })).toEqual([]);
    expect(await refusalOf(engine.getDelivery({ id: delivery.id }))).toContain("doesn't exist");
    expect(await refusalOf(engine.deliveryUpdate({ id: delivery.id, title: 'Frozen' }))).toContain(
      'archived',
    );
    expect(
      await refusalOf(engine.deliveryCreate({ phase: phase.id, project: 'DEL', title: 'Frozen' })),
    ).toContain('archived');
  } finally {
    await fixture.close();
  }
});

test('creation refuses a task, a foreign phase, and invalid time caps without consuming an id', async () => {
  const fixture = await createTestStore();
  try {
    const engine = new LocalEngine(fixture.store);
    await engine.create({ key: 'DEL', name: 'Delivery', type: 'project' });
    await engine.create({ key: 'OTH', name: 'Other', type: 'project' });
    const root = await engine.create({ parent: 'DEL', title: 'Plan', type: 'initiative' });
    const phase = await engine.create({ parent: root.id, title: 'Phase', type: 'phase' });
    const task = await engine.create({ parent: phase.id, title: 'Task', type: 'task' });
    const foreign = await engine.create({ parent: 'OTH', title: 'Elsewhere', type: 'initiative' });
    const foreignPhase = await engine.create({
      parent: foreign.id,
      title: 'Foreign',
      type: 'phase',
    });
    expect(
      await refusalOf(engine.deliveryCreate({ phase: task.id, project: 'DEL', title: 'Bad' })),
    ).toContain('phase');
    expect(
      await refusalOf(
        engine.deliveryCreate({ phase: foreignPhase.id, project: 'DEL', title: 'Bad' }),
      ),
    ).toContain('same project');
    expect(
      await refusalOf(
        engine.deliveryCreate({
          phase: phase.id,
          project: 'DEL',
          time_cap_minutes: 0,
          title: 'Bad',
        }),
      ),
    ).toContain('0');
    expect(
      await refusalOf(
        engine.deliveryCreate({
          phase: phase.id,
          project: 'DEL',
          time_cap_minutes: 1.5,
          title: 'Bad',
        }),
      ),
    ).toContain('expected int');
    const delivery = await engine.deliveryCreate({
      phase: phase.id,
      project: 'DEL',
      title: 'Good',
    });
    expect(delivery.id).toBe('DEL-d1');
    await engine.done({ id: task.id });
    expect(
      await refusalOf(
        engine.deliveryCreate({ phase: phase.id, project: 'DEL', title: 'Ended phase' }),
      ),
    ).toContain('live phase');
  } finally {
    await fixture.close();
  }
});
