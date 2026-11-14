import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import type { StoreExport } from './export';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);

const INT32_OVERFLOW = 2 ** 31;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type ExportedDelivery = StoreExport['deliveries'][number];
type HistoryRow = ExportedDelivery['history'][number];

const lifecycleRow = (from: string, to: string, at: string): HistoryRow => ({
  at,
  from_value: from,
  kind: 'lifecycle',
  reason: null,
  task: null,
  to_value: to,
});

const member = (overrides: Partial<HistoryRow>): HistoryRow => ({
  at: minutesAgo(1),
  from_value: null,
  kind: 'member',
  reason: null,
  task: 'DEL-3',
  to_value: 'joined',
  ...overrides,
});

describe.each(backends)('delivery record ($name)', (backend) => {
  /** A store holding DEL with one phase, one task under it, and one delivery DEL-d1. */
  async function seeded() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    await createProject(instance.store, { key: 'DEL', name: 'Delivery' });
    const initiative = await createInitiative(instance.store, { projectId: 'DEL', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const task = await createTask(instance.store, { parentId: phase.id, title: 'Task' });
    const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
    return { delivery, engine, instance, phase: phase.id, task: task.id };
  }

  /** The seeded store's export, with its one delivery edited by `edit`. */
  async function documentWith(
    edit: (delivery: ExportedDelivery, document: StoreExport) => void,
  ): Promise<StoreExport> {
    const { instance } = await seeded();
    try {
      const document = structuredClone(await instance.store.export());
      const delivery = document.deliveries[0];
      if (delivery === undefined) {
        throw new Error('missing fixture');
      }
      edit(delivery, document);
      return document;
    } finally {
      await instance.close();
    }
  }

  /** Import `document` fresh into an empty store; returns the refusal or the target. */
  async function importRefusal(document: StoreExport): Promise<string> {
    const target = await backend.make();
    try {
      const error = await errorOf(target.store.import(document, { dryRun: false, mode: 'fresh' }));
      expect(error.code).toBe('validation');
      return error.message;
    } finally {
      await target.close();
    }
  }

  test('history and allocation survive transfer, terminal records refuse writes', async () => {
    const { engine, instance, delivery: created, phase } = await seeded();
    const target = await backend.make();
    try {
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
      const document = structuredClone(await instance.store.export());
      const delivery = document.deliveries[0];
      const project = document.projects[0];
      if (delivery === undefined || project === undefined) {
        throw new Error('missing fixture');
      }
      delivery.lifecycle = 'landed';
      delivery.history.push(lifecycleRow('agreed', 'running', '2026-01-01T00:00:00.000Z'));
      project.counters.delivery = 10;
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      const restored = new LocalEngine(target.store);
      expect((await restored.getDelivery({ id: created.id })).elapsed_minutes).toBeGreaterThan(0);
      expect(
        await refusalOf(restored.deliveryUpdate({ id: created.id, title: 'Frozen' })),
      ).toContain('terminal');
      expect((await restored.deliveryCreate({ phase, title: 'Second' })).id).toBe('DEL-d11');
      expect((await restored.deliveries({ project: 'DEL' })).length).toBe(2);
    } finally {
      await instance.close();
      await target.close();
    }
  });

  test('a time cap past int32 is refused as validation on create and update', async () => {
    const { engine, instance, delivery, phase } = await seeded();
    try {
      for (const write of [
        engine.deliveryCreate({ phase, time_cap_minutes: INT32_OVERFLOW, title: 'Huge' }),
        engine.deliveryUpdate({ id: delivery.id, time_cap_minutes: INT32_OVERFLOW }),
      ]) {
        expect((await errorOf(write)).code).toBe('validation');
      }
      const largest = await engine.deliveryUpdate({
        id: delivery.id,
        time_cap_minutes: INT32_OVERFLOW - 1,
      });
      expect(largest.time_cap_minutes).toBe(INT32_OVERFLOW - 1);
    } finally {
      await instance.close();
    }
  });

  test('an imported seq or time cap past int32 is refused as validation', async () => {
    const seq = await documentWith((delivery) => {
      delivery.seq = INT32_OVERFLOW;
      delivery.id = `DEL-d${String(INT32_OVERFLOW)}`;
    });
    await importRefusal(seq);
    const cap = await documentWith((delivery) => {
      delivery.time_cap_minutes = INT32_OVERFLOW;
    });
    await importRefusal(cap);
  });

  test.each([
    ['created_at', '2026-01-01'],
    ['updated_at', '2026-01-01T00:00:00Z'],
  ] as const)('an imported delivery with a non-canonical %s is refused', async (field, value) => {
    const document = await documentWith((delivery) => {
      delivery[field] = value;
    });
    expect(await importRefusal(document)).toContain(`${field} must be a canonical instant`);
  });

  test('an imported delivery history row with a non-canonical at is refused', async () => {
    const document = await documentWith((delivery) => {
      delivery.lifecycle = 'running';
      delivery.history.push(lifecycleRow('agreed', 'running', 'yesterday'));
    });
    expect(await importRefusal(document)).toContain('at must be a canonical instant');
  });

  test.each([
    ['a lifecycle row to an unknown value', lifecycleRow('agreed', 'flying', minutesAgo(1))],
    [
      'a lifecycle row from no value',
      { ...lifecycleRow('agreed', 'running', minutesAgo(1)), from_value: null },
    ],
    [
      'a hold row to an unknown value',
      { ...lifecycleRow('none', 'held', minutesAgo(1)), kind: 'hold' as const },
    ],
    [
      'a hold row from a lifecycle value',
      { ...lifecycleRow('agreed', 'stopped', minutesAgo(1)), kind: 'hold' as const },
    ],
  ])('an imported delivery with %s is refused', async (_name, row) => {
    const document = await documentWith((delivery) => {
      delivery.history.push(row);
    });
    expect(await importRefusal(document)).toContain('history');
  });

  test('an imported delivery with a blank title is refused', async () => {
    const document = await documentWith((delivery) => {
      delivery.title = '   ';
    });
    expect(await importRefusal(document)).toContain('title is blank');
  });

  test('an imported terminal delivery that is held is refused', async () => {
    const document = await documentWith((delivery) => {
      delivery.lifecycle = 'landed';
      delivery.hold = 'stopped';
      delivery.hold_reason = 'waiting';
    });
    expect(await importRefusal(document)).toContain('terminal delivery must have no hold');
  });

  test.each([
    ['a reason with no hold', { hold: 'none' as const, hold_reason: 'stray' }],
    ['a hold with no reason', { hold: 'paused' as const, hold_reason: null }],
  ])('an imported delivery with %s is refused', async (_name, fields) => {
    const document = await documentWith((delivery) => {
      Object.assign(delivery, fields);
    });
    expect(await importRefusal(document)).toContain('hold reason disagrees with hold');
  });

  test('an imported member row that is not a valid event is refused', async () => {
    const valid = await documentWith((delivery) => {
      delivery.history.push(member({}));
    });
    const target = await backend.make();
    try {
      await target.store.import(valid, { dryRun: false, mode: 'fresh' });
    } finally {
      await target.close();
    }
    for (const overrides of [{ from_value: 'joined' }, { to_value: 'wandered' }, { task: null }]) {
      const document = await documentWith((delivery) => {
        delivery.history.push(member(overrides));
      });
      expect(await importRefusal(document)).toContain('invalid member history');
    }
  });

  test('an imported member row that names a phase or initiative is refused', async () => {
    for (const container of ['DEL-1', 'DEL-2']) {
      const document = await documentWith((delivery) => {
        delivery.history.push(member({ task: container }));
      });
      expect(await importRefusal(document)).toContain(`member history names ${container}`);
    }
  });

  test('an imported lifecycle row that names a task is refused', async () => {
    const document = await documentWith((delivery) => {
      delivery.lifecycle = 'running';
      delivery.history.push({ ...lifecycleRow('agreed', 'running', minutesAgo(1)), task: 'DEL-3' });
    });
    expect(await importRefusal(document)).toContain('only member history names a task');
  });

  test('an imported delivery whose id disagrees with its seq is refused', async () => {
    const document = await documentWith((delivery) => {
      delivery.id = 'DEL-d5';
    });
    expect(await importRefusal(document)).toContain('identity disagrees');
  });

  test('a fresh import allocates past the highest carried delivery seq', async () => {
    const document = await documentWith((delivery, doc) => {
      delivery.seq = 3;
      delivery.id = 'DEL-d3';
      const project = doc.projects[0];
      if (project !== undefined) {
        project.counters.delivery = 0;
      }
    });
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const phase = document.deliveries[0]?.phase ?? '';
      const next = await new LocalEngine(target.store).deliveryCreate({ phase, title: 'Next' });
      expect(next.id).toBe('DEL-d4');
    } finally {
      await target.close();
    }
  });

  test('a resume raises the delivery counter of a project it already holds', async () => {
    const document = await documentWith((_delivery, doc) => {
      Object.assign(doc, { deliveries: [] });
      const project = doc.projects[0];
      if (project !== undefined) {
        project.counters.delivery = 0;
      }
    });
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const raised = structuredClone(document);
      const project = raised.projects[0];
      if (project === undefined) {
        throw new Error('missing fixture');
      }
      project.counters.delivery = 7;
      await target.store.import(raised, { dryRun: false, mode: 'resume' });
      const phase = document.nodes.find((node) => node.type === 'phase')?.id ?? '';
      const next = await new LocalEngine(target.store).deliveryCreate({ phase, title: 'Next' });
      expect(next.id).toBe('DEL-d8');
    } finally {
      await target.close();
    }
  });

  test('elapsed time runs from the first start, never below zero', async () => {
    const document = await documentWith((delivery, doc) => {
      delivery.lifecycle = 'running';
      delivery.history.push(
        {
          at: '2000-01-01T00:00:00.000Z',
          from_value: 'none',
          kind: 'hold',
          reason: 'old pause',
          task: null,
          to_value: 'paused',
        },
        { ...lifecycleRow('paused', 'none', minutesAgo(90)), kind: 'hold' },
        lifecycleRow('agreed', 'running', minutesAgo(60)),
        lifecycleRow('running', 'milestone', minutesAgo(30)),
        lifecycleRow('milestone', 'running', minutesAgo(10)),
      );
      const future = structuredClone(delivery);
      future.id = 'DEL-d2';
      future.seq = 2;
      future.history = [lifecycleRow('agreed', 'running', '2999-01-01T00:00:00.000Z')];
      Object.assign(doc, { deliveries: [delivery, future] });
      const project = doc.projects[0];
      if (project !== undefined) {
        project.counters.delivery = 2;
      }
    });
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const engine = new LocalEngine(target.store);
      const started = await engine.getDelivery({ id: 'DEL-d1' });
      expect(started.elapsed_minutes).toBeGreaterThan(59);
      expect(started.elapsed_minutes).toBeLessThan(62);
      expect((await engine.getDelivery({ id: 'DEL-d2' })).elapsed_minutes).toBe(0);
    } finally {
      await target.close();
    }
  });

  test('a create past the last int32 delivery seq is refused as validation', async () => {
    const document = await documentWith((_delivery, doc) => {
      Object.assign(doc, { deliveries: [] });
      const project = doc.projects[0];
      if (project !== undefined) {
        project.counters.delivery = INT32_OVERFLOW - 1;
      }
    });
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const phase = document.nodes.find((node) => node.type === 'phase')?.id ?? '';
      const engine = new LocalEngine(target.store);
      expect((await errorOf(engine.deliveryCreate({ phase, title: 'Overflow' }))).code).toBe(
        'validation',
      );
      expect(await engine.deliveries({ project: 'DEL' })).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('the store refuses a write to an archived project inside the write itself', async () => {
    const { engine, instance, phase } = await seeded();
    try {
      // The verbs check the board first; the store must hold the lock too, so an
      // archive that lands between that check and the write cannot be overwritten.
      await engine.archive({ id: 'DEL' });
      const deliveries = instance.store.deliveries;
      expect((await errorOf(deliveries.patch('DEL', 1, { title: 'After archive' }))).code).toBe(
        'conflict',
      );
      const create = deliveries.create({
        agreement: null,
        branch: null,
        external_ref: null,
        harness: null,
        host: null,
        key: 'DEL',
        phase,
        session: null,
        time_cap_minutes: null,
        title: 'After archive',
      });
      expect((await errorOf(create)).code).toBe('conflict');
      expect((await deliveries.load('DEL', 1))?.title).toBe('Attempt');
      expect(await deliveries.load('DEL', 2)).toBeUndefined();
    } finally {
      await instance.close();
    }
  });

  test('the store patch writes fields and history in one write, and refuses an absent delivery', async () => {
    const { instance } = await seeded();
    try {
      const deliveries = instance.store.deliveries;
      const at = '2026-02-01T00:00:00.000Z';
      await deliveries.patch('DEL', 1, { title: 'Patched' }, [
        { at, from_value: 'none', kind: 'hold', reason: 'wait', task: null, to_value: 'paused' },
        { at, from_value: 'paused', kind: 'hold', reason: null, task: null, to_value: 'none' },
      ]);
      const loaded = await deliveries.load('DEL', 1);
      expect(loaded?.title).toBe('Patched');
      expect(loaded?.history.map((row) => row.to_value)).toEqual(['paused', 'none']);
      expect(await deliveries.load('DEL', 9)).toBeUndefined();
      expect((await errorOf(deliveries.patch('DEL', 9, { title: 'x' }))).code).toBe('not_found');
    } finally {
      await instance.close();
    }
  });
});
