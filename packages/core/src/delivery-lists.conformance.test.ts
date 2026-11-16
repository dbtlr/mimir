import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { archiveProject } from './mutations';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf } from './testing/conformance';

beforeAll(bootPglite);

describe.each(backends)('delivery limitations and declined findings ($name)', (backend) => {
  async function fixture() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    await createProject(instance.store, { key: 'LST', name: 'Lists' });
    const initiative = await createInitiative(instance.store, { projectId: 'LST', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const task = await createTask(instance.store, { parentId: phase.id, title: 'Task' });
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      title: 'Attempt',
    });
    return { ...instance, engine, id: delivery.id, phase: phase.id, task: task.id };
  }

  test('limitation and decline share one per-delivery numbering', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryLimitation({ id: f.id, text: 'A cancelled run is charged in full' });
      const declined = await f.engine.deliveryDecline({
        finding: 'Retry the clone',
        id: f.id,
        reason: 'Filed as LST-s1',
      });
      const both = await f.engine.deliveryLimitation({ id: f.id, text: 'Second limit' });
      expect(declined.declined.map((d) => [d.number, d.finding, d.reason])).toEqual([
        [2, 'Retry the clone', 'Filed as LST-s1'],
      ]);
      expect(both.limitations.map((l) => [l.number, l.text])).toEqual([
        [1, 'A cancelled run is charged in full'],
        [3, 'Second limit'],
      ]);
      expect(both.limitations[0]?.created_at).toBeInstanceOf(Date);
      const read = await f.engine.getDelivery({ id: f.id });
      expect(read.limitations).toEqual(both.limitations);
      expect(read.declined).toEqual(both.declined);
      expect(read.journal).toEqual({ artifacts: [], scratchpad: null });
    } finally {
      await f.close();
    }
  });

  test('the deliveries list rows do not carry the lists', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryLimitation({ id: f.id, text: 'x' });
      const [row] = await f.engine.deliveries({ project: 'LST' });
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('limitations');
      expect(row).not.toHaveProperty('declined');
      expect(row).not.toHaveProperty('journal');
    } finally {
      await f.close();
    }
  });

  test('blank text and a blank or missing reason are validation', async () => {
    const f = await fixture();
    try {
      for (const call of [
        () => f.engine.deliveryLimitation({ id: f.id, text: '  ' }),
        () => f.engine.deliveryDecline({ finding: ' ', id: f.id, reason: 'why' }),
        () => f.engine.deliveryDecline({ finding: 'a', id: f.id, reason: '  ' }),
        () => f.engine.deliveryDecline({ finding: 'a', id: f.id } as never),
      ]) {
        expect((await errorOf(call())).code).toBe('validation');
      }
      expect((await f.engine.getDelivery({ id: f.id })).limitations).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test('a non-delivery id is validation naming its kind; a missing delivery is not_found', async () => {
    const f = await fixture();
    try {
      const task = await errorOf(f.engine.deliveryLimitation({ id: f.task, text: 'x' }));
      expect(task.code).toBe('validation');
      expect(task.message).toContain('not a delivery');
      const project = await errorOf(
        f.engine.deliveryDecline({ finding: 'a', id: 'LST', reason: 'b' }),
      );
      expect(project.code).toBe('validation');
      expect((await errorOf(f.engine.deliveryLimitation({ id: 'LST-d99', text: 'x' }))).code).toBe(
        'not_found',
      );
    } finally {
      await f.close();
    }
  });

  test('both verbs work in every lifecycle and under holds, and stamp updated_at', async () => {
    const f = await fixture();
    try {
      setSystemTime(new Date(Date.now() + 60_000));
      const before = (await f.engine.getDelivery({ id: f.id })).updated_at;
      setSystemTime(new Date(Date.now() + 120_000));
      const after = await f.engine.deliveryLimitation({ id: f.id, text: 'agreed ok' });
      expect(after.updated_at.getTime()).toBeGreaterThan(before.getTime());
      await f.engine.deliveryAbandon({ id: f.id, reason: 'drop it' });
      const abandoned = await f.engine.deliveryDecline({
        finding: 'late finding',
        id: f.id,
        reason: 'after the fact',
      });
      expect(abandoned.lifecycle).toBe('abandoned');
      expect(abandoned.declined).toHaveLength(1);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('works on a landed delivery and on stopped and paused holds', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryStart({ id: f.id });
      await f.engine.deliveryBlock({ id: f.id, reason: 'wait' });
      expect((await f.engine.deliveryLimitation({ id: f.id, text: 'stopped' })).hold).toBe(
        'stopped',
      );
      await f.engine.deliveryUnblock({ id: f.id });
      await f.engine.deliveryPark({ id: f.id, reason: 'later' });
      expect((await f.engine.deliveryLimitation({ id: f.id, text: 'paused' })).hold).toBe('paused');
      await f.engine.deliveryUnpark({ id: f.id });
      await f.engine.deliverySubmit({ id: f.id });
      await f.engine.start({ harness: 'codex', id: f.task, session: 's' });
      await f.engine.submit({ id: f.task });
      await f.engine.stage({ id: f.task });
      await f.engine.deliveryLand({ id: f.id });
      const landed = await f.engine.deliveryDecline({
        finding: 'post-merge finding',
        id: f.id,
        reason: 'found after the merge',
      });
      expect(landed.lifecycle).toBe('landed');
      expect(landed.limitations.map((l) => l.number)).toEqual([1, 2]);
      expect(landed.declined.map((d) => d.number)).toEqual([3]);
    } finally {
      await f.close();
    }
  });

  test('an archived project refuses both verbs', async () => {
    const f = await fixture();
    try {
      await archiveProject(f.store, 'LST');
      expect((await errorOf(f.engine.deliveryLimitation({ id: f.id, text: 'x' }))).code).toBe(
        'conflict',
      );
      expect(
        (await errorOf(f.engine.deliveryDecline({ finding: 'a', id: f.id, reason: 'b' }))).code,
      ).toBe('conflict');
    } finally {
      await f.close();
    }
  });
});
