import { expect, setDefaultTimeout, test } from 'bun:test';

import { backends } from '../../testing/conformance';
import { createInitiative, createProject } from '../create';
import { createPgliteTestStore } from '../store-postgres/testing';
import { createScratchpadService } from './service';

setDefaultTimeout(60_000);

async function rejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toMatch(message);
    return;
  }
  throw new Error('expected the operation to reject');
}

// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  test.skipIf(backend.skip)(
    `${backend.name}: scratchpad links must name existing work in its project`,
    async () => {
      const fixture = await backend.make();
      try {
        const { store } = fixture;
        await createProject(store, { key: 'MMR', name: 'Mimir' });
        await createProject(store, { key: 'NRN', name: 'Norn' });
        const local = await createInitiative(store, { projectId: 'MMR', title: 'Local work' });
        const foreign = await createInitiative(store, { projectId: 'NRN', title: 'Foreign work' });
        const service = createScratchpadService(store.scratchpads, store.artifacts, store);
        const pad = await service.create({
          anchors: [local.id, local.id],
          project: 'MMR',
          title: 'Valid',
        });
        expect(pad.anchors).toEqual([local.id]);
        for (const [anchor, message] of [
          [`${local.id},${local.id}`, /doesn't exist/],
          ['MMR-999', /doesn't exist/],
          ['MMR', /is a project/],
          ['MMR-a1', /is an artifact/],
          ['MMR-s1', /is a seed/],
          [foreign.id, /project disagrees/],
        ] as const) {
          await rejection(
            service.create({ anchors: [anchor], project: 'MMR', title: 'Invalid' }),
            message,
          );
          await rejection(
            service.updateMetadata(pad.id, {
              anchors: [anchor],
              expectedUpdatedAt: pad.updatedAt,
              title: 'Must not persist',
            }),
            message,
          );
          expect(await service.get(pad.id)).toEqual(pad);
          expect(await service.list()).toHaveLength(1);
        }
        const artifact = await service.freeze(pad.id, {
          expectedUpdatedAt: pad.updatedAt,
          summary: 'Valid links freeze',
        });
        expect(artifact.links).toEqual([local.id]);
      } finally {
        await fixture.close();
      }
    },
  );
}

// Legacy Postgres rows retain invalid anchors; Norn's tolerant reader filters them.
test('freeze refuses legacy invalid links before staging or allocating an artifact', async () => {
  const fixture = await createPgliteTestStore();
  try {
    const { store } = fixture;
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const service = createScratchpadService(store.scratchpads, store.artifacts, store);
    const pad = await service.create({ project: 'MMR', title: 'Legacy' });
    const legacy = { ...pad, anchors: ['MMR-999'], updatedAt: '2099-01-01T00:00:00.000Z' };
    await store.scratchpads.replace(legacy, pad.updatedAt);
    await rejection(
      service.freeze(pad.id, { expectedUpdatedAt: legacy.updatedAt, summary: 'Must not stage' }),
      /MMR-999 doesn't exist/,
    );
    expect(await service.get(pad.id)).toEqual(legacy);
    expect(await store.artifacts.findBySourceScratch(pad.id)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test('a stranded pad can repair its invalid links without losing episode content', async () => {
  const fixture = await createPgliteTestStore();
  try {
    const { store } = fixture;
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const local = await createInitiative(store, { projectId: 'MMR', title: 'Linked work' });
    const service = createScratchpadService(store.scratchpads, store.artifacts, store);
    const pad = await service.create({ project: 'MMR', title: 'Stranded' });
    const checkpoint = await service.checkpoint(pad.id, {
      content: 'Keep this finding',
      expectedUpdatedAt: pad.updatedAt,
    });
    const agenda = await service.agendaAdd(pad.id, {
      content: 'Unresolved question',
      expectedUpdatedAt: checkpoint.updatedAt,
    });
    const stranded = {
      ...agenda,
      anchors: ['MMR-999'],
      freezingAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    await store.scratchpads.replace(stranded, agenda.updatedAt);
    await rejection(
      service.updateMetadata(pad.id, { anchors: [], expectedUpdatedAt: agenda.updatedAt }),
      /changed concurrently/,
    );
    await rejection(
      service.updateMetadata(pad.id, {
        anchors: ['MMR-998'],
        expectedUpdatedAt: stranded.updatedAt,
      }),
      /MMR-998 doesn't exist/,
    );
    expect(await service.get(pad.id)).toEqual(stranded);
    const repaired = await service.updateMetadata(pad.id, {
      anchors: [local.id],
      expectedUpdatedAt: stranded.updatedAt,
    });
    expect(repaired.freezingAt).toBeNull();
    expect(repaired.updatedAt > stranded.updatedAt).toBe(true);
    expect(repaired.journal).toEqual(agenda.journal);
    expect(repaired.agenda).toEqual(agenda.agenda);
    const artifact = await service.freeze(pad.id, {
      expectedUpdatedAt: repaired.updatedAt,
      summary: 'Recovered',
    });
    expect(artifact.links).toEqual([local.id]);
    expect(artifact.content).toContain('Keep this finding');
    expect(artifact.content).toContain('Unresolved question');
    expect(await store.artifacts.findBySourceScratch(pad.id)).toEqual(artifact);
    expect(await store.scratchpads.load(pad.id)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test('clearing stranded links preserves discard safeguards for open Agenda items', async () => {
  const fixture = await createPgliteTestStore();
  try {
    const { store } = fixture;
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const service = createScratchpadService(store.scratchpads, store.artifacts, store);
    const pad = await service.create({ project: 'MMR', title: 'Stranded' });
    const agenda = await service.agendaAdd(pad.id, {
      content: 'Unresolved question',
      expectedUpdatedAt: pad.updatedAt,
    });
    const stranded = {
      ...agenda,
      anchors: ['MMR-1,MMR-2'],
      freezingAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    await store.scratchpads.replace(stranded, agenda.updatedAt);
    const repaired = await service.updateMetadata(pad.id, {
      anchors: [],
      expectedUpdatedAt: stranded.updatedAt,
    });
    expect(repaired.freezingAt).toBeNull();
    expect(repaired.anchors).toEqual([]);
    await rejection(
      service.discard(pad.id, { expectedUpdatedAt: repaired.updatedAt }),
      /open Agenda/,
    );
    await rejection(
      service.discard(pad.id, { expectedUpdatedAt: repaired.updatedAt, force: true }),
      /requires a reason/,
    );
    await service.discard(pad.id, {
      expectedUpdatedAt: repaired.updatedAt,
      force: true,
      reason: 'Episode abandoned',
    });
    expect(await store.scratchpads.load(pad.id)).toBeUndefined();
    expect(await store.artifacts.findBySourceScratch(pad.id)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test('an existing source artifact prevents repair and remains authoritative on freeze retry', async () => {
  const fixture = await createPgliteTestStore();
  try {
    const { store } = fixture;
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const local = await createInitiative(store, { projectId: 'MMR', title: 'Linked work' });
    const service = createScratchpadService(store.scratchpads, store.artifacts, store);
    const pad = await service.create({ anchors: [local.id], project: 'MMR', title: 'Committed' });
    const artifact = await service.freeze(pad.id, {
      expectedUpdatedAt: pad.updatedAt,
      summary: 'Original summary',
    });
    // Model an old staged document left behind after its artifact was committed.
    const stranded = {
      ...pad,
      anchors: ['MMR-999'],
      freezingAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    await store.scratchpads.create(stranded);
    await rejection(
      service.updateMetadata(pad.id, { anchors: [], expectedUpdatedAt: stranded.updatedAt }),
      /already has a frozen artifact/,
    );
    expect(await service.get(pad.id)).toEqual(stranded);
    expect(
      await service.freeze(pad.id, { expectedUpdatedAt: stranded.updatedAt, summary: 'Ignored' }),
    ).toEqual(artifact);
    expect(await store.artifacts.findBySourceScratch(pad.id)).toEqual(artifact);
    expect(await store.scratchpads.load(pad.id)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
