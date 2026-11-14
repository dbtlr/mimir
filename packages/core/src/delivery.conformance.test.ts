import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery record ($name)', (backend) => {
  test('history and allocation survive transfer, terminal records refuse writes', async () => {
    const source = await backend.make();
    const target = await backend.make();
    try {
      const engine = new LocalEngine(source.store);
      await createProject(source.store, { key: 'DEL', name: 'Delivery' });
      const initiative = await createInitiative(source.store, {
        projectId: 'DEL',
        title: 'Plan',
      });
      const phase = await createPhase(source.store, { parentId: initiative.id, title: 'Phase' });
      const created = await engine.deliveryCreate({
        phase: phase.id,
        project: 'DEL',
        title: 'Attempt',
      });
      expect(
        (
          await engine.deliveryUpdate({
            agreement: 'Terms',
            branch: 'work',
            external_ref: 'pr/1',
            harness: 'codex',
            host: 'machine',
            id: created.id,
            session: 'thread',
            time_cap_minutes: 30,
            title: 'Revised',
          })
        ).title,
      ).toBe('Revised');
      const document = structuredClone(await source.store.export());
      const delivery = document.deliveries[0];
      const project = document.projects[0];
      if (delivery === undefined || project === undefined) {
        throw new Error('missing fixture');
      }
      delivery.lifecycle = 'landed';
      delivery.history.push({
        at: '2026-01-01T00:00:00.000Z',
        from_value: 'agreed',
        kind: 'lifecycle',
        reason: null,
        task: null,
        to_value: 'running',
      });
      project.counters.delivery = 10;
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      const restored = new LocalEngine(target.store);
      expect((await restored.getDelivery({ id: created.id })).elapsed_minutes).toBeGreaterThan(0);
      expect(
        await refusalOf(restored.deliveryUpdate({ id: created.id, title: 'Frozen' })),
      ).toContain('terminal');
      expect(
        (await restored.deliveryCreate({ phase: phase.id, project: 'DEL', title: 'Second' })).id,
      ).toBe('DEL-d11');
      expect((await restored.deliveries({ project: 'DEL' })).length).toBe(2);
    } finally {
      await source.close();
      await target.close();
    }
  });
});
