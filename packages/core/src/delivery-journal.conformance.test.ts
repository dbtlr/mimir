import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf } from './testing/conformance';

beforeAll(bootPglite);

describe.each(backends)('delivery run journal ($name)', (backend) => {
  async function fixture() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    await createProject(instance.store, { key: 'JRN', name: 'Journals' });
    await createProject(instance.store, { key: 'OTH', name: 'Other' });
    const initiative = await createInitiative(instance.store, { projectId: 'JRN', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const tasks = [];
    for (const title of ['A', 'B', 'C']) {
      tasks.push((await createTask(instance.store, { parentId: phase.id, title })).id);
    }
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      tasks: [tasks[0] as string, tasks[1] as string],
      title: 'Attempt',
    });
    const otherInitiative = await createInitiative(instance.store, {
      projectId: 'OTH',
      title: 'Plan',
    });
    const otherPhase = await createPhase(instance.store, {
      parentId: otherInitiative.id,
      title: 'Phase',
    });
    await createTask(instance.store, { parentId: otherPhase.id, title: 'T' });
    const other = await engine.deliveryCreate({ phase: otherPhase.id, title: 'Other attempt' });
    return { ...instance, delivery: delivery.id, engine, other: other.id, phase: phase.id, tasks };
  }
  const pad = async (f: Awaited<ReturnType<typeof fixture>>, anchors?: string[]) =>
    f.engine.scratchCreate({ anchors, project: 'JRN', title: 'Journal' });

  test('create links a delivery beside node anchors, and views carry it', async () => {
    const f = await fixture();
    try {
      const created = await pad(f, [f.tasks[2] as string, f.delivery]);
      expect(created.delivery).toBe(f.delivery);
      expect(created.anchors).toEqual([f.tasks[2] as string]);
      expect((await f.engine.scratchGet({ id: created.id })).delivery).toBe(f.delivery);
      expect((await f.engine.scratchList({ project: 'JRN' }))[0]?.delivery).toBe(f.delivery);
      const read = await f.engine.getDelivery({ id: f.delivery });
      expect(read.journal).toEqual({ artifacts: [], scratchpad: created.id });
      expect((await pad(f)).delivery).toBeNull();
    } finally {
      await f.close();
    }
  });

  test('a delivery of another project, two deliveries, and a missing delivery are refused', async () => {
    const f = await fixture();
    try {
      expect((await errorOf(pad(f, [f.other]))).code).toBe('validation');
      await f.engine.deliveryCreate({ phase: f.phase, title: 'Second' });
      const two = await errorOf(pad(f, [f.delivery, 'JRN-d2']));
      expect(two.code).toBe('validation');
      expect((await errorOf(pad(f, ['JRN-d9']))).code).toBe('not_found');
    } finally {
      await f.close();
    }
  });

  test('a second live pad on a delivery conflicts naming the holder, until freeze or discard', async () => {
    const f = await fixture();
    try {
      const first = await pad(f, [f.delivery]);
      const refusal = await errorOf(pad(f, [f.delivery]));
      expect(refusal.code).toBe('conflict');
      expect(refusal.message).toContain(first.id);
      const loose = await pad(f);
      const viaUpdate = await errorOf(
        f.engine.scratchUpdate({
          anchors: [f.delivery],
          expectedUpdatedAt: loose.updatedAt,
          id: loose.id,
        }),
      );
      expect(viaUpdate.code).toBe('conflict');
      expect(viaUpdate.message).toContain(first.id);
      await f.engine.scratchDiscard({ expectedUpdatedAt: first.updatedAt, id: first.id });
      const again = await pad(f, [f.delivery]);
      await f.engine.scratchFreeze({
        expectedUpdatedAt: again.updatedAt,
        id: again.id,
        summary: 'done',
      });
      expect((await pad(f, [f.delivery])).delivery).toBe(f.delivery);
    } finally {
      await f.close();
    }
  });

  test('a delivery id with leading zeros names the same delivery (finding 1)', async () => {
    const f = await fixture();
    try {
      const first = await pad(f, [f.delivery]);
      const refusal = await errorOf(pad(f, ['JRN-d01']));
      expect(refusal.code).toBe('conflict');
      expect(refusal.message).toContain(first.id);
      await f.engine.scratchDiscard({ expectedUpdatedAt: first.updatedAt, id: first.id });
      const padded = await pad(f, ['JRN-d01']);
      expect(padded.delivery).toBe(f.delivery);
      const frozen = await f.engine.scratchFreeze({
        expectedUpdatedAt: padded.updatedAt,
        id: padded.id,
        summary: 'run journal',
      });
      expect(frozen.delivery).toBe(f.delivery);
      expect(frozen.links).toEqual([f.tasks[0] as string, f.tasks[1] as string].toSorted());
      const read = await f.engine.getDelivery({ id: f.delivery });
      expect(read.journal.artifacts).toEqual([frozen.id]);
    } finally {
      await f.close();
    }
  });

  test('repeating one delivery id, in any spelling, is one delivery (finding 1)', async () => {
    const f = await fixture();
    try {
      const same = await pad(f, [f.delivery, f.delivery]);
      expect(same.delivery).toBe(f.delivery);
      await f.engine.scratchDiscard({ expectedUpdatedAt: same.updatedAt, id: same.id });
      expect((await pad(f, [f.delivery, 'JRN-d01'])).delivery).toBe(f.delivery);
    } finally {
      await f.close();
    }
  });

  test('journal artifacts list oldest first (finding 7)', async () => {
    const f = await fixture();
    try {
      const one = await pad(f, [f.delivery]);
      const first = await f.engine.scratchFreeze({
        expectedUpdatedAt: one.updatedAt,
        id: one.id,
        summary: 'first',
      });
      const two = await pad(f, [f.delivery]);
      const second = await f.engine.scratchFreeze({
        expectedUpdatedAt: two.updatedAt,
        id: two.id,
        summary: 'second',
      });
      const read = await f.engine.getDelivery({ id: f.delivery });
      expect(read.journal.artifacts).toEqual([first.id, second.id]);
    } finally {
      await f.close();
    }
  });

  test('update keeps, replaces, or clears the delivery with the anchors', async () => {
    const f = await fixture();
    try {
      const created = await pad(f, [f.tasks[2] as string, f.delivery]);
      const titled = await f.engine.scratchUpdate({
        expectedUpdatedAt: created.updatedAt,
        id: created.id,
        title: 'Renamed',
      });
      expect(titled.delivery).toBe(f.delivery);
      expect(titled.anchors).toEqual([f.tasks[2] as string]);
      const relinked = await f.engine.scratchUpdate({
        anchors: [f.tasks[0] as string],
        expectedUpdatedAt: titled.updatedAt,
        id: created.id,
      });
      expect(relinked.delivery).toBeNull();
      expect(relinked.anchors).toEqual([f.tasks[0] as string]);
      const back = await f.engine.scratchUpdate({
        anchors: [f.delivery],
        expectedUpdatedAt: relinked.updatedAt,
        id: created.id,
      });
      expect(back.delivery).toBe(f.delivery);
      expect(back.anchors).toEqual([]);
      const cleared = await f.engine.scratchUpdate({
        anchors: [],
        expectedUpdatedAt: back.updatedAt,
        id: created.id,
      });
      expect(cleared.delivery).toBeNull();
    } finally {
      await f.close();
    }
  });

  test('freeze names the delivery and links anchors plus every task ever a member', async () => {
    const f = await fixture();
    try {
      const [a, b, c] = f.tasks as [string, string, string];
      // b leaves, so it is no longer a member but stays in the history.
      await f.engine.update({ delivery: null, id: b });
      const created = await pad(f, [c, f.delivery]);
      const frozen = await f.engine.scratchFreeze({
        expectedUpdatedAt: created.updatedAt,
        id: created.id,
        summary: 'run journal',
      });
      expect(frozen.delivery).toBe(f.delivery);
      expect(frozen.links).toEqual([a, b, c].toSorted());
      const read = await f.engine.getDelivery({ id: f.delivery });
      expect(read.journal.scratchpad).toBeNull();
      expect(read.journal.artifacts).toEqual([frozen.id]);
      expect((await f.engine.getArtifact({ id: frozen.id })).delivery).toBe(f.delivery);
    } finally {
      await f.close();
    }
  });

  test('includes members that were released by an abandon', async () => {
    const f = await fixture();
    try {
      const created = await pad(f, [f.delivery]);
      await f.engine.deliveryAbandon({ id: f.delivery, reason: 'stop' });
      const frozen = await f.engine.scratchFreeze({
        expectedUpdatedAt: created.updatedAt,
        id: created.id,
        summary: 'run journal',
      });
      expect(frozen.links).toEqual([f.tasks[0] as string, f.tasks[1] as string].toSorted());
    } finally {
      await f.close();
    }
  });

  test('a freeze retried after the artifact exists returns it with its original links', async () => {
    const f = await fixture();
    try {
      const created = await pad(f, [f.delivery]);
      const raw = await f.store.scratchpads.load(created.id);
      if (raw === undefined) {
        throw new Error('fixture');
      }
      const first = await f.engine.scratchFreeze({
        expectedUpdatedAt: created.updatedAt,
        id: created.id,
        summary: 'run journal',
      });
      // The pad is gone after a full freeze; restage it as a crash between create and delete.
      await f.store.scratchpads.create({ ...raw, freezingAt: raw.updatedAt });
      await f.engine.update({ delivery: f.delivery, id: f.tasks[2] as string });
      const retry = await f.engine.scratchFreeze({
        expectedUpdatedAt: created.updatedAt,
        id: created.id,
        summary: 'run journal',
      });
      expect(retry.id).toBe(first.id);
      expect(retry.links).toEqual(first.links);
      expect(retry.links).not.toContain(f.tasks[2] as string);
    } finally {
      await f.close();
    }
  });
});
