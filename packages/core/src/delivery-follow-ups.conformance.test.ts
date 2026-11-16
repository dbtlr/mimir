import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { archiveProject, unarchiveProject } from './mutations';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery follow-ups ($name)', (backend) => {
  async function fixture() {
    const f = await backend.make();
    const engine = new LocalEngine(f.store);
    await createProject(f.store, { key: 'FUP', name: 'Follow-ups' });
    await createProject(f.store, { key: 'OTH', name: 'Other' });
    const initiative = await createInitiative(f.store, { projectId: 'FUP', title: 'Plan' });
    const phase = await createPhase(f.store, { parentId: initiative.id, title: 'Phase' });
    const task = await createTask(f.store, { parentId: phase.id, title: 'Cleanup' });
    const other = await createInitiative(f.store, { projectId: 'OTH', title: 'Other plan' });
    const foreign = await createTask(f.store, { parentId: other.id, title: 'Foreign' });
    const seed = await engine.seedCreate({ kind: 'idea', project: 'OTH', title: 'Ask' });
    const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
    return {
      ...f,
      engine,
      foreign: foreign.id,
      id: delivery.id,
      phase: phase.id,
      seed: seed.id,
      task: task.id,
    };
  }

  test('cross-board seeds retain row order, can be unlinked and relinked, and archive hides links and events', async () => {
    const f = await fixture();
    try {
      const write = await f.engine.deliveryUpdate({ follow_ups: [f.seed, f.task], id: f.id });
      expect(write.follow_ups.map((link) => link.id)).toEqual([f.seed, f.task]);
      await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] });
      const relinked = await f.engine.deliveryUpdate({ follow_ups: [f.seed], id: f.id });
      expect(relinked.follow_ups.map((link) => link.id)).toEqual([f.task, f.seed]);
      await archiveProject(f.store, 'OTH');
      expect((await f.engine.getDelivery({ id: f.id })).follow_ups.map((link) => link.id)).toEqual([
        f.task,
      ]);
      const hidden = await errorOf(f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] }));
      expect(hidden.code).toBe('not_found');
      const feed = await f.engine.deliverySince({
        id: f.id,
        since: new Date('2020-01-01T00:00:00.000Z'),
      });
      expect(
        feed.events.filter((event) => event.kind === 'follow_up').map((event) => event.text),
      ).toEqual([f.task]);
    } finally {
      await f.close();
    }
  });

  test('holds and each lifecycle accept follow-ups, including landed', async () => {
    const f = await fixture();
    try {
      const link = async () => {
        expect(
          (await f.engine.deliveryUpdate({ follow_ups: [f.seed], id: f.id })).follow_ups.map(
            (row) => row.id,
          ),
        ).toEqual([f.seed]);
        await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] });
      };
      await link();
      await f.engine.deliveryUpdate({ agreement: 'Ship', id: f.id });
      await f.engine.deliveryStart({ id: f.id });
      await link();
      await f.engine.deliveryBlock({ id: f.id, reason: 'wait' });
      await link();
      await f.engine.deliveryUnblock({ id: f.id });
      await f.engine.deliveryPark({ id: f.id, reason: 'later' });
      await link();
      await f.engine.deliveryUnpark({ id: f.id });
      await f.engine.deliverySubmit({ id: f.id });
      await link();
      await f.engine.start({ harness: 'test', id: f.task, session: 'test' });
      await f.engine.submit({ id: f.task });
      await f.engine.stage({ id: f.task });
      await f.engine.deliveryLand({ id: f.id });
      await link();
    } finally {
      await f.close();
    }
  });

  test('an unlink alone appears after the cursor and archive suppression reverses on unarchive', async () => {
    const f = await fixture();
    try {
      setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      await f.engine.deliveryUpdate({ follow_ups: [f.seed], id: f.id });
      setSystemTime(new Date('2030-01-03T00:00:00.000Z'));
      await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] });
      const input = { id: f.id, since: new Date('2030-01-02T00:00:00.000Z') };
      expect((await f.engine.deliverySince(input)).events.map((event) => event.id)).toEqual([
        'FUP-d1/follow-up/1/unlinked',
      ]);
      await archiveProject(f.store, 'OTH');
      expect((await f.engine.deliverySince(input)).events).toEqual([]);
      await unarchiveProject(f.store, 'OTH');
      expect((await f.engine.deliverySince(input)).events.map((event) => event.id)).toEqual([
        'FUP-d1/follow-up/1/unlinked',
      ]);
    } finally {
      setSystemTime();
      await f.close();
    }
  });
  test('refusals follow delivery, duplicates, grammar, existence, type, project, and link state order', async () => {
    const f = await fixture();
    try {
      const cases: { id: string; follow_ups: string[]; code: string; message: string }[] = [
        { code: 'not_found', follow_ups: ['bad', 'bad'], id: 'FUP-d999', message: 'FUP-d999' },
        { code: 'validation', follow_ups: ['bad', 'bad'], id: f.id, message: 'more than once' },
        { code: 'not_found', follow_ups: ['bad'], id: f.id, message: 'bad' },
        ...['FUP', 'FUP-d1', 'FUP-q1', 'FUP-a1'].map((id) => ({
          code: 'validation',
          follow_ups: [id],
          id: f.id,
          message: id,
        })),
        { code: 'not_found', follow_ups: [f.phase, 'FUP-999'], id: f.id, message: 'FUP-999' },
        { code: 'validation', follow_ups: [f.foreign, f.phase], id: f.id, message: 'phase' },
        { code: 'validation', follow_ups: [f.foreign], id: f.id, message: 'another project' },
      ];
      for (const { code, message, ...input } of cases) {
        const refusal = await errorOf(f.engine.deliveryUpdate(input));
        expect(code).toBe(refusal.code);
        expect(refusal.message).toContain(message);
      }
      await f.engine.deliveryUpdate({ follow_ups: [f.task], id: f.id });
      expect(
        (await errorOf(f.engine.deliveryUpdate({ follow_ups: [f.task], id: f.id }))).message,
      ).toContain('already linked');
      expect(
        (await errorOf(f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] }))).message,
      ).toContain('not linked');
      expect(
        (
          await errorOf(
            f.engine.deliveryUpdate({ follow_ups: [f.task], id: f.id, unfollow_ups: [f.task] }),
          )
        ).message,
      ).toContain('more than once');
      await archiveProject(f.store, 'OTH');
      expect(
        (await errorOf(f.engine.deliveryUpdate({ follow_ups: [f.foreign], id: f.id }))).code,
      ).toBe('not_found');
      await archiveProject(f.store, 'FUP');
      expect(
        (await errorOf(f.engine.deliveryUpdate({ follow_ups: ['bad', 'bad'], id: 'FUP-d999' })))
          .code,
      ).toBe('conflict');
    } finally {
      await f.close();
    }
  });

  test('terminal deliveries accept only follow-up changes and all refusals roll back', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryAbandon({ id: f.id, reason: 'ended' });
      const linked = await f.engine.deliveryUpdate({ follow_ups: [f.task], id: f.id });
      expect(linked.lifecycle).toBe('abandoned');
      for (const input of [{ title: 'Changed', unfollow_ups: [f.task] }, {}, { follow_ups: [] }]) {
        expect((await errorOf(f.engine.deliveryUpdate({ id: f.id, ...input }))).message).toContain(
          'terminal',
        );
      }
      expect(
        (await errorOf(f.engine.deliveryUpdate({ follow_ups: ['bad'], id: f.id, title: ' ' })))
          .message,
      ).toContain('title');
      expect((await f.engine.getDelivery({ id: f.id })).follow_ups).toEqual(linked.follow_ups);
      expect(
        (await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.task] })).follow_ups,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test('unlink clamps its clock and since orders findings, follow-ups, then member transitions', async () => {
    const f = await fixture();
    try {
      setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      await f.engine.deliveryLimitation({ id: f.id, text: 'Limit' });
      await f.engine.deliveryUpdate({ follow_ups: [f.seed], id: f.id });
      await f.engine.start({ harness: 'test', id: f.task, session: 'test' });
      setSystemTime(new Date('2029-12-31T00:00:00.000Z'));
      await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] });
      const feed = await f.engine.deliverySince({
        id: f.id,
        since: new Date('2029-12-30T00:00:00.000Z'),
      });
      expect(feed.events.map((event) => event.kind)).toEqual([
        'limitation',
        'follow_up',
        'follow_up',
        'lifecycle',
      ]);
      expect(feed.events.filter((event) => event.kind === 'follow_up')).toEqual([
        {
          at: new Date('2030-01-01T00:00:00.000Z'),
          from: null,
          id: 'FUP-d1/follow-up/1/linked',
          kind: 'follow_up',
          number: null,
          reason: null,
          record: f.id,
          task: null,
          text: f.seed,
          to: 'linked',
        },
        {
          at: new Date('2030-01-01T00:00:00.000Z'),
          from: 'linked',
          id: 'FUP-d1/follow-up/1/unlinked',
          kind: 'follow_up',
          number: null,
          reason: null,
          record: f.id,
          task: null,
          text: f.seed,
          to: 'unlinked',
        },
      ]);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('export round-trips retained rows in insertion order and resume compares links', async () => {
    const f = await fixture();
    const target = await backend.make();
    try {
      await f.engine.deliveryUpdate({ follow_ups: [f.seed, f.task], id: f.id });
      await f.engine.deliveryUpdate({ id: f.id, unfollow_ups: [f.seed] });
      await f.engine.deliveryUpdate({ follow_ups: [f.seed], id: f.id });
      const document = await f.store.export();
      expect(document.schema_version).toBe(14);
      expect(document.delivery_follow_ups.map((row) => row.task ?? row.seed)).toEqual([
        f.seed,
        f.task,
        f.seed,
      ]);
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      await target.store.import(document, { dryRun: false, mode: 'resume' });
      const changed = structuredClone(document);
      changed.delivery_follow_ups = [];
      expect(
        (await errorOf(target.store.import(changed, { dryRun: false, mode: 'resume' }))).message,
      ).toContain('differs');
    } finally {
      await target.close();
      await f.close();
    }
  });
  test('import refuses malformed links before writing any rows', async () => {
    const f = await fixture();
    const target = await backend.make();
    try {
      await f.engine.deliveryUpdate({ follow_ups: [f.task], id: f.id });
      const document = await f.store.export();
      const row = document.delivery_follow_ups[0];
      if (!row) {
        throw new Error('missing fixture link');
      }
      for (const patch of [
        { delivery: 'FUP-d999' },
        { seed: f.seed },
        { task: null },
        { task: 'FUP-999' },
        { task: f.phase },
        { task: f.foreign },
        { seed: 'OTH-s999', task: null },
        { linked_at: 'bad' },
        { unlinked_at: 'bad' },
        { unlinked_at: '0100-01-01T00:00:00.000Z' },
      ]) {
        const broken = { ...document, delivery_follow_ups: [{ ...row, ...patch }] };
        expect(
          (await errorOf(target.store.import(broken, { dryRun: false, mode: 'fresh' }))).code,
        ).toBe('validation');
      }
      expect(
        (
          await errorOf(
            target.store.import(
              { ...document, delivery_follow_ups: [row, row] },
              { dryRun: false, mode: 'fresh' },
            ),
          )
        ).message,
      ).toContain('duplicate standing');
      expect((await target.store.export()).projects).toEqual([]);
    } finally {
      await target.close();
      await f.close();
    }
  });
  test('a late link refusal rolls back its title and earlier unlinks', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryUpdate({ follow_ups: [f.task, f.seed], id: f.id });
      const before = await f.engine.getDelivery({ id: f.id });
      expect(
        (
          await errorOf(
            f.engine.deliveryUpdate({
              follow_ups: [f.seed],
              id: f.id,
              title: 'Changed',
              unfollow_ups: [f.task],
            }),
          )
        ).code,
      ).toBe('validation');
      expect(await f.engine.getDelivery({ id: f.id })).toEqual(before);
    } finally {
      await f.close();
    }
  });

  test('an older export imports without links', async () => {
    const f = await fixture();
    const target = await backend.make();
    try {
      const { delivery_follow_ups: _links, ...older } = await f.store.export();
      await target.store.import({ ...older, schema_version: 13 }, { dryRun: false, mode: 'fresh' });
      expect((await target.store.export()).delivery_follow_ups).toEqual([]);
    } finally {
      await target.close();
      await f.close();
    }
  });
  test('linking and unlinking a task returns the same detail as get', async () => {
    const f = await backend.make();
    try {
      const engine = new LocalEngine(f.store);
      await createProject(f.store, { key: 'FUP', name: 'Follow-ups' });
      const initiative = await createInitiative(f.store, { projectId: 'FUP', title: 'Plan' });
      const phase = await createPhase(f.store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(f.store, { parentId: phase.id, title: 'Cleanup' });
      const delivery = await engine.deliveryCreate({ phase: phase.id, title: 'Attempt' });
      const linked = await engine.deliveryUpdate({ follow_ups: [task.id], id: delivery.id });
      expect(linked.follow_ups).toEqual([
        { id: task.id, linked_at: expect.any(Date), status: 'ready', title: 'Cleanup' },
      ]);
      expect(await engine.getDelivery({ id: delivery.id })).toEqual(linked);
      expect(
        (await engine.deliveryUpdate({ id: delivery.id, unfollow_ups: [task.id] })).follow_ups,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
