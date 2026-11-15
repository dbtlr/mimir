import { beforeAll, describe, expect, test, setSystemTime } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet, becameReadyAt } from './derive';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery board ($name)', (backend) => {
  async function fixture() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    await createProject(instance.store, { key: 'DEL', name: 'Delivery' });
    const initiative = await createInitiative(instance.store, { projectId: 'DEL', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const a = await createTask(instance.store, { parentId: phase.id, title: 'Prerequisite' });
    const b = await createTask(instance.store, { parentId: phase.id, title: 'Dependent' });
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship',
      phase: phase.id,
      title: 'Attempt',
    });
    return { ...instance, a, b, delivery, engine, phase };
  }
  test('next excludes members and restores a task that leaves', async () => {
    const f = await fixture();
    try {
      expect((await f.engine.next({ project: 'DEL' })).items).toEqual([]);
      await f.engine.update({ delivery: null, id: f.b.id });
      expect((await f.engine.next({ project: 'DEL' })).items.map((n) => n.id)).toEqual([f.b.id]);
    } finally {
      await f.close();
    }
  });
  test('same delivery submit settles only direct member dependencies, even held, and updates rollup and blocking', async () => {
    const f = await fixture();
    try {
      await f.engine.depend({ id: f.b.id, on: [f.a.id] });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('awaiting');
      expect(
        (await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items.map((n) => n.id),
      ).toEqual([f.a.id]);
      await f.engine.start({ id: f.a.id });
      await f.engine.submit({ id: f.a.id });
      await f.engine.block({ id: f.a.id, reason: 'decision' });
      expect((await f.engine.getNode({ facets: ['deps'], id: f.b.id })).status).toBe('ready');
      expect((await f.engine.getNode({ facets: ['deps'], id: f.b.id })).deps?.awaitingOn).toEqual(
        [],
      );
      expect(
        (await f.engine.getNode({ facets: ['verdicts'], id: f.a.id })).verdicts?.blocking,
      ).toBe(false);
      expect(
        (await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items.map((n) => n.id),
      ).toEqual([f.b.id]);
      expect(
        (await f.engine.getNode({ facets: ['distribution'], id: f.phase.id })).distribution,
      ).toEqual({ blocked: 1, ready: 1 });
      await f.engine.unblock({ id: f.a.id });
      await f.engine.stage({ id: f.a.id });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('ready');
      await f.engine.update({ delivery: null, id: f.b.id });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('awaiting');
      expect(
        (await f.engine.getNode({ facets: ['verdicts'], id: f.a.id })).verdicts?.blocking,
      ).toBe(true);
      const other = await f.engine.deliveryCreate({
        phase: f.phase.id,
        tasks: [f.b.id],
        title: 'Other',
      });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('awaiting');
      await f.engine.update({ delivery: null, id: f.b.id });
      await f.engine.update({ delivery: f.delivery.id, id: f.b.id });
      await f.engine.return({ id: f.a.id });
      await f.engine.update({ delivery: null, id: f.a.id });
      await f.engine.submit({ id: f.a.id });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('awaiting');
      expect((await f.engine.next({ delivery: other.id, project: 'DEL' })).items).toEqual([]);
      // Dependencies remain advisory even when the member is awaiting.
      await f.engine.start({ id: f.b.id });
      expect((await f.engine.getNode({ id: f.b.id })).status).toBe('in_progress');
    } finally {
      await f.close();
    }
  });

  test('delivery next keeps rank, selects ready members, and refuses wrong kinds and archived projects', async () => {
    const f = await fixture();
    try {
      expect(
        (await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items.map((n) => n.id),
      ).toEqual([f.a.id, f.b.id]);
      await f.engine.reorder({ id: f.b.id, position: 'top' });
      expect(
        (await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items.map((n) => n.id),
      ).toEqual([f.b.id, f.a.id]);
      await f.engine.park({ id: f.a.id, reason: 'later' });
      expect(
        (await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items.map((n) => n.id),
      ).toEqual([f.b.id]);
      expect(await refusalOf(f.engine.next({ delivery: f.phase.id, project: 'DEL' }))).toContain(
        'not a delivery',
      );
      await f.engine.archive({ id: 'DEL' });
      expect(await refusalOf(f.engine.next({ delivery: f.delivery.id, project: 'DEL' }))).toContain(
        "doesn't exist",
      );
    } finally {
      await f.close();
    }
  });
  test('abandon restores ready members to next and terminal delivery next is empty; land unlocks outside work', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryAbandon({ id: f.delivery.id, reason: 'retry' });
      expect((await f.engine.next({ project: 'DEL' })).items.map((n) => n.id)).toEqual([
        f.a.id,
        f.b.id,
      ]);
      expect((await f.engine.next({ delivery: f.delivery.id, project: 'DEL' })).items).toEqual([]);
      const d = await f.engine.deliveryCreate({
        agreement: 'ship',
        phase: f.phase.id,
        tasks: [f.a.id],
        title: 'Retry',
      });
      await f.engine.depend({ id: f.b.id, on: [f.a.id] });
      await f.engine.deliveryStart({ id: d.id });
      await f.engine.start({ id: f.a.id });
      await f.engine.submit({ id: f.a.id });
      await f.engine.stage({ id: f.a.id });
      expect((await f.engine.next({ project: 'DEL' })).items).toEqual([]);
      await f.engine.deliverySubmit({ id: d.id });
      await f.engine.deliveryLand({ id: d.id });
      expect((await f.engine.next({ project: 'DEL' })).items.map((n) => n.id)).toEqual([f.b.id]);
      expect((await f.engine.next({ delivery: d.id, project: 'DEL' })).items).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test('ready time follows submit, join, and release history, guarded by current readiness', async () => {
    const f = await fixture();
    const readyAt = async () => becameReadyAt(deriveSet(await f.store.loadWorkingSet()), f.b.id);
    try {
      await f.engine.depend({ id: f.b.id, on: [f.a.id] });
      expect(await readyAt()).toBeNull();
      await f.engine.start({ id: f.a.id });
      setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      await f.engine.submit({ id: f.a.id });
      expect(await readyAt()).toBe('2030-01-01T00:00:00.000Z');
      await f.engine.update({ delivery: null, id: f.b.id });
      expect(await readyAt()).toBeNull();
      setSystemTime(new Date('2030-01-02T00:00:00.000Z'));
      await f.engine.update({ delivery: f.delivery.id, id: f.b.id });
      expect(await readyAt()).toBe('2030-01-02T00:00:00.000Z');
      setSystemTime(new Date('2030-01-03T00:00:00.000Z'));
      await f.engine.deliveryAbandon({ id: f.delivery.id, reason: 'release' });
      expect(await readyAt()).toBeNull();
      await f.engine.start({ id: f.a.id });
      await f.engine.done({ id: f.a.id });
      expect(await readyAt()).toBe('2030-01-03T00:00:00.000Z');
      const d = await f.engine.deliveryCreate({
        phase: f.phase.id,
        tasks: [f.b.id],
        title: 'Release untouched',
      });
      setSystemTime(new Date('2030-01-04T00:00:00.000Z'));
      await f.engine.deliveryAbandon({ id: d.id, reason: 'release todo' });
      expect(await readyAt()).toBe('2030-01-04T00:00:00.000Z');
      setSystemTime(new Date('2030-01-05T00:00:00.000Z'));
      await f.engine.update({ id: f.b.id, title: 'Renamed without a readiness change' });
      expect(await readyAt()).toBe('2030-01-04T00:00:00.000Z');
    } finally {
      setSystemTime();
      await f.close();
    }
  });
  test('without a delivery ordinary dependencies and rank order are unchanged', async () => {
    const f = await backend.make();
    const engine = new LocalEngine(f.store);
    try {
      await createProject(f.store, { key: 'OLD', name: 'Ordinary board' });
      const parent = await createInitiative(f.store, { projectId: 'OLD', title: 'Plan' });
      const a = await createTask(f.store, { parentId: parent.id, title: 'First' });
      const b = await createTask(f.store, { parentId: parent.id, title: 'Second' });
      await engine.depend({ id: b.id, on: [a.id] });
      expect((await engine.next({ project: 'OLD' })).items.map((n) => n.id)).toEqual([a.id]);
      await engine.start({ id: a.id });
      await engine.submit({ id: a.id });
      expect((await engine.getNode({ id: b.id })).status).toBe('awaiting');
      expect((await engine.next({ project: 'OLD' })).items).toEqual([]);
      await engine.done({ id: a.id });
      expect((await engine.next({ project: 'OLD' })).items.map((n) => n.id)).toEqual([b.id]);
    } finally {
      await f.close();
    }
  });
});
