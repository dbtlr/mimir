import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createProject, createInitiative, createPhase } from './create';
import { LocalEngine } from './engine';
import { parseIdentity, renderDeliveryRef } from './ids';
import { errorOf, refusalOf } from './testing/conformance';
import { createTestStore } from './testing/store';
import type { TestStore } from './testing/store';

/** A project with one initiative, one phase, and one task under it. */
async function board(fixture: TestStore) {
  const engine = new LocalEngine(fixture.store);
  await createProject(fixture.store, { key: 'DEL', name: 'Delivery' });
  const initiative = await createInitiative(fixture.store, { projectId: 'DEL', title: 'Plan' });
  const phase = await createPhase(fixture.store, { parentId: initiative.id, title: 'Phase' });
  return { engine, initiative, phase };
}

test('a delivery records an attempt beside its phase, and updates replace its terms', async () => {
  const fixture = await createTestStore();
  try {
    const { engine, initiative, phase } = await board(fixture);
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      time_cap_minutes: 15,
      title: 'Attempt',
    });
    expect(delivery.id).toBe('DEL-d1');
    expect(delivery.project_key).toBe('DEL');
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
    expect(await engine.getDelivery({ id: delivery.id })).toMatchObject(updated);
    expect(await engine.deliveries({ project: 'DEL' })).toEqual([updated]);
    expect(
      await refusalOf(engine.deliveryCreate({ phase: initiative.id, title: 'Invalid' })),
    ).toContain('phase');
    expect(await refusalOf(engine.start({ id: delivery.id }))).toContain('delivery');
    const exported = await fixture.store.export();
    expect(exported.projects[0]?.counters.delivery).toBe(1);
    const target = await createTestStore();
    try {
      await target.store.import(exported, { dryRun: false, mode: 'fresh' });
      expect(await new LocalEngine(target.store).getDelivery({ id: delivery.id })).toMatchObject(
        updated,
      );
    } finally {
      await target.close();
    }
  } finally {
    await fixture.close();
  }
});

describe('delivery verbs', () => {
  let fixture: TestStore;
  let engine: LocalEngine;
  let phase: string;
  let initiative: string;
  beforeEach(async () => {
    fixture = await createTestStore();
    const made = await board(fixture);
    engine = made.engine;
    phase = made.phase.id;
    initiative = made.initiative.id;
  });
  afterEach(async () => {
    await fixture.close();
  });

  test('create refuses a task and an initiative as the phase, without consuming an id', async () => {
    const task = await engine.create({ parent: phase, title: 'Task', type: 'task' });
    for (const id of [task.id, initiative]) {
      const error = await errorOf(engine.deliveryCreate({ phase: id, title: 'Bad' }));
      expect(error.code).toBe('validation');
      expect(error.message).toContain('phase');
    }
    expect(
      (await errorOf(engine.deliveryCreate({ phase: initiative, title: 'Bad' }))).message,
    ).toBe(`${initiative} is an initiative, not a phase — a delivery delivers a phase`);
    expect((await engine.deliveryCreate({ phase, title: 'Good' })).id).toBe('DEL-d1');
  });

  test('create takes its project from the phase', async () => {
    await engine.create({ key: 'OTH', name: 'Other', type: 'project' });
    const root = await engine.create({ parent: 'OTH', title: 'Elsewhere', type: 'initiative' });
    const other = await engine.create({ parent: root.id, title: 'Far', type: 'phase' });
    const delivery = await engine.deliveryCreate({ phase: other.id, title: 'There' });
    expect(delivery.id).toBe('OTH-d1');
    expect(delivery.project_key).toBe('OTH');
  });

  test('create accepts a phase whose tasks are all settled', async () => {
    const task = await engine.create({ parent: phase, title: 'Task', type: 'task' });
    await engine.done({ id: task.id });
    expect((await engine.deliveryCreate({ phase, title: 'After' })).id).toBe('DEL-d1');
    const abandoned = await engine.create({ parent: initiative, title: 'Dropped', type: 'phase' });
    const dropped = await engine.create({ parent: abandoned.id, title: 'Gone', type: 'task' });
    await engine.abandon({ id: dropped.id, reason: 'not needed' });
    expect((await engine.deliveryCreate({ phase: abandoned.id, title: 'Retry' })).id).toBe(
      'DEL-d2',
    );
  });

  test('create refuses a phase that does not exist as not found', async () => {
    const missing = await errorOf(engine.deliveryCreate({ phase: 'DEL-99', title: 'Ghost' }));
    expect(missing.code).toBe('not_found');
    expect(missing.message).toContain('DEL-99');
    const unknown = await errorOf(engine.deliveryCreate({ phase: 'ZZZ-1', title: 'Ghost' }));
    expect(unknown.code).toBe('not_found');
  });

  test('create refuses a phase id of another kind as a behavioral error', async () => {
    for (const id of ['DEL', 'DEL-s1', 'DEL-a1', 'DEL-d1']) {
      const error = await errorOf(engine.deliveryCreate({ phase: id, title: 'Bad' }));
      expect(error.code).toBe('validation');
      expect(error.message).toContain('phase');
    }
  });

  test('create no longer takes a project', async () => {
    const error = await errorOf(
      engine.deliveryCreate({ phase, project: 'DEL', title: 'Old shape' } as never),
    );
    expect(error.code).toBe('validation');
  });

  test('create and update refuse a blank title and blank agreement text', async () => {
    expect(await refusalOf(engine.deliveryCreate({ phase, title: '   ' }))).toContain('title');
    for (const blank of ['', '  \n ']) {
      const created = await errorOf(engine.deliveryCreate({ agreement: blank, phase, title: 'x' }));
      expect(created.code).toBe('validation');
      expect(created.message).toBe('agreement cannot be blank');
    }
    const delivery = await engine.deliveryCreate({ agreement: 'Terms', phase, title: 'x' });
    const updated = await errorOf(engine.deliveryUpdate({ agreement: ' ', id: delivery.id }));
    expect(updated.message).toBe('agreement cannot be blank');
    expect(updated.hint).toBe('send null to clear it');
    expect((await engine.getDelivery({ id: delivery.id })).agreement).toBe('Terms');
    expect(
      (await engine.deliveryUpdate({ agreement: null, id: delivery.id })).agreement,
    ).toBeNull();
  });

  test('blank handle text clears the handle, as a task update does', async () => {
    const delivery = await engine.deliveryCreate({
      branch: 'feat/x',
      harness: 'codex',
      host: 'box',
      phase,
      session: 'thread',
      title: 'Handles',
    });
    expect(delivery.branch).toBe('feat/x');
    const cleared = await engine.deliveryUpdate({
      branch: '',
      harness: '  ',
      host: '',
      id: delivery.id,
      session: ' ',
    });
    expect([cleared.branch, cleared.harness, cleared.host, cleared.session]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const spaced = await engine.deliveryUpdate({ branch: '  feat/y \n', id: delivery.id });
    expect(spaced.branch).toBe('feat/y');
  });

  test('deliveries refuses an unknown project as seeds does', async () => {
    const error = await errorOf(engine.deliveries({ project: 'ZZZ' }));
    expect(error.code).toBe('not_found');
    expect(error.message).toBe("ZZZ doesn't exist");
    expect(error.hint).toContain('create project');
  });

  test('an archived project hides and freezes its deliveries', async () => {
    const delivery = await engine.deliveryCreate({ phase, title: 'Attempt' });
    await engine.archive({ id: 'DEL' });
    expect((await errorOf(engine.deliveries({ project: 'DEL' }))).code).toBe('not_found');
    expect(await refusalOf(engine.getDelivery({ id: delivery.id }))).toContain("doesn't exist");
    expect(await refusalOf(engine.deliveryUpdate({ id: delivery.id, title: 'Frozen' }))).toContain(
      'archived',
    );
    expect(await refusalOf(engine.deliveryCreate({ phase, title: 'Frozen' }))).toContain(
      'archived',
    );
  });

  test('the delivery reads refuse an id of another kind as a behavioral error', async () => {
    for (const id of [phase, 'DEL', 'DEL-s1', 'DEL-a1']) {
      const read = await errorOf(engine.getDelivery({ id }));
      expect(read.code).toBe('validation');
      expect(read.message).toContain('not a delivery');
      const write = await errorOf(engine.deliveryUpdate({ id, title: 'x' }));
      expect(write.code).toBe('validation');
      expect(write.message).toContain('not a delivery');
    }
    expect((await errorOf(engine.getDelivery({ id: 'DEL-d9' }))).code).toBe('not_found');
  });

  test('node verbs refuse a delivery id as a behavioral error', async () => {
    const delivery = await engine.deliveryCreate({ phase, title: 'Attempt' });
    const update = await errorOf(engine.update({ id: delivery.id, title: 'x' }));
    expect(update.code).toBe('validation');
    expect(update.message).toContain('is a delivery');
    const annotate = await errorOf(engine.annotate({ content: 'note', id: delivery.id }));
    expect(annotate.code).toBe('validation');
    expect(annotate.message).toContain('is a delivery');
    const tag = await errorOf(engine.tag({ ids: [delivery.id], tags: ['x'] }));
    expect(tag.code).toBe('validation');
    expect(tag.message).toContain('is a delivery');
  });
});
