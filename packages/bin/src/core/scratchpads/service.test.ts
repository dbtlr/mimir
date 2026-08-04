import { describe, expect, test } from 'bun:test';

import type { Scratchpad } from '@mimir/contract';

import type { ArtifactCreate, ArtifactRecord, ArtifactStore } from '../artifacts/store';
import { createScratchpadService } from './service';
import type { ScratchpadStore } from './store';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const T0 = '2026-08-03T12:00:00.000Z';

async function rejection(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

function harness() {
  const pads = new Map<string, Scratchpad>();
  const frozen = new Map<string, ArtifactRecord & { content: string }>();
  const creates: ArtifactCreate[] = [];
  let failCreateOnce = false;
  let failDeleteOnce = false;
  let tick = 0;
  const projects = {
    loadProjects: () =>
      Promise.resolve([
        {
          archived_at: null,
          created_at: T0,
          description: null,
          key: 'MMR',
          name: 'Mimir',
          updated_at: T0,
        },
      ]),
  };
  const scratchpads: ScratchpadStore = {
    async create(pad) {
      pads.set(pad.id, structuredClone(pad));
    },
    async delete(id, expected) {
      const pad = pads.get(id);
      if (pad !== undefined && pad.updatedAt !== expected) {
        throw new Error('CAS delete');
      }
      if (failDeleteOnce) {
        failDeleteOnce = false;
        throw new Error('injected delete failure');
      }
      pads.delete(id);
    },
    async list(project) {
      return [...pads.values()].filter((pad) => project === undefined || pad.project === project);
    },
    async load(id) {
      const pad = pads.get(id);
      return pad === undefined ? undefined : structuredClone(pad);
    },
    async replace(pad, expected) {
      if (pads.get(pad.id)?.updatedAt !== expected) {
        throw new Error('CAS replace');
      }
      pads.set(pad.id, structuredClone(pad));
    },
  };
  const artifacts: ArtifactStore = {
    async applyTag() {},
    async create(input) {
      if (failCreateOnce) {
        failCreateOnce = false;
        throw new Error('injected artifact failure');
      }
      creates.push(structuredClone(input));
      const record = {
        content: input.content,
        created_at: T0,
        key: input.key,
        links: input.links,
        seq: creates.length,
        summary: input.summary ?? null,
        tags: input.tags,
        title: input.title,
        updated_at: T0,
      };
      if (input.sourceScratch !== undefined) {
        frozen.set(input.sourceScratch, record);
      }
      return record;
    },
    async findBySourceScratch(id) {
      return frozen.get(id);
    },
    async list() {
      return { items: [], total: 0 };
    },
    async listForNode() {
      return [];
    },
    async listForProject() {
      return [];
    },
    async load() {
      return undefined;
    },
    async removeTags() {
      return 0;
    },
    async updateMetadata() {
      return false;
    },
  };
  const service = createScratchpadService(scratchpads, artifacts, projects, {
    clock: () => new Date(new Date(T0).valueOf() + tick++ * 1000).toISOString(),
    uuid: () => ID,
  });
  return {
    artifacts,
    creates,
    failNextCreate: () => {
      failCreateOnce = true;
    },
    failNextDelete: () => {
      failDeleteOnce = true;
    },
    frozen,
    pads,
    service,
    serviceStore: scratchpads,
  };
}

describe('ScratchpadService', () => {
  test('create rejects missing and archived projects before persistence', async () => {
    const h = harness();
    await rejection(
      () => h.service.create({ project: 'NOPE', title: 'Missing' }),
      /project NOPE doesn't exist/,
    );
    const archivedProjects = {
      loadProjects: async () => [
        {
          archived_at: T0,
          created_at: T0,
          description: null,
          key: 'ARC',
          name: 'Archived',
          updated_at: T0,
        },
      ],
    };
    const archivedService = createScratchpadService(h.serviceStore, h.artifacts, archivedProjects);
    await rejection(
      () => archivedService.create({ project: 'ARC', title: 'Archived' }),
      /project ARC is archived/,
    );
    expect(h.pads.size).toBe(0);
  });
  test('owns create, checkpoint, Agenda transitions, metadata, reads, and CAS', async () => {
    const h = harness();
    const created = await h.service.create({
      anchors: ['MMR-1'],
      project: 'MMR',
      title: ' Shape ',
    });
    expect(created).toMatchObject({ id: ID, project: 'MMR', title: 'Shape' });
    expect(await h.service.list('MMR')).toHaveLength(1);
    const checkpointed = await h.service.checkpoint(ID, {
      content: 'First finding',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(checkpointed.journal).toEqual([
      { at: '2026-08-03T12:00:01.000Z', content: 'First finding', number: 1 },
    ]);
    const added = await h.service.agendaAdd(ID, {
      content: 'Settle API',
      expectedUpdatedAt: checkpointed.updatedAt,
    });
    const done = await h.service.agendaComplete(ID, {
      expectedUpdatedAt: added.updatedAt,
      number: 1,
    });
    expect(done.agenda[0]?.state).toBe('done');
    const second = await h.service.agendaAdd(ID, {
      content: 'Old direction',
      expectedUpdatedAt: done.updatedAt,
    });
    const superseded = await h.service.agendaSupersede(ID, {
      expectedUpdatedAt: second.updatedAt,
      number: 2,
      reason: 'replaced',
    });
    expect(superseded.agenda[1]).toMatchObject({
      reason: 'replaced',
      state: 'superseded',
    });
    const renamed = await h.service.updateMetadata(ID, {
      anchors: ['MMR-2', 'MMR-2'],
      expectedUpdatedAt: superseded.updatedAt,
      title: 'Final shape',
    });
    expect(renamed).toMatchObject({ anchors: ['MMR-2'], title: 'Final shape' });
    await rejection(
      () =>
        h.service.checkpoint(ID, {
          content: 'stale',
          expectedUpdatedAt: created.updatedAt,
        }),
      /changed concurrently/,
    );
  });

  test('freeze stages, creates one self-contained provenance artifact, and recovers deletion', async () => {
    const h = harness();
    const created = await h.service.create({
      anchors: ['MMR-1'],
      project: 'MMR',
      title: 'Shape',
    });
    const checkpointed = await h.service.checkpoint(ID, {
      content: 'The complete body',
      expectedUpdatedAt: created.updatedAt,
    });
    h.failNextDelete();
    await rejection(
      () =>
        h.service.freeze(ID, {
          expectedUpdatedAt: checkpointed.updatedAt,
          summary: ' Durable\nsummary ',
          tags: ['spec', 'scratchpad'],
        }),
      /injected/,
    );
    const staged = await h.service.get(ID);
    expect(staged.freezingAt).not.toBeNull();
    await rejection(
      () =>
        h.service.checkpoint(ID, {
          content: 'stale content',
          expectedUpdatedAt: staged.updatedAt,
        }),
      /freezing/,
    );

    const artifact = await h.service.freeze(ID, {
      expectedUpdatedAt: staged.updatedAt,
      summary: 'ignored on artifact recovery',
      tags: ['different'],
    });
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      key: 'MMR',
      links: ['MMR-1'],
      sourceScratch: ID,
      summary: 'Durable summary',
      tags: ['scratchpad', 'spec'],
      title: 'Shape',
    });
    expect(artifact.content).toContain('The complete body');
    expect(artifact.content).not.toContain('stale content');
    await rejection(() => h.service.get(ID), /doesn't exist/);

    const retried = await h.service.freeze(ID, {
      expectedUpdatedAt: staged.updatedAt,
      summary: 'anything',
    });
    expect(retried).toEqual(artifact);
    expect(h.creates).toHaveLength(1);
  });

  test('freeze requires a summary and discard guards unresolved Agenda', async () => {
    const h = harness();
    const created = await h.service.create({ project: 'MMR', title: 'Shape' });
    await rejection(
      () =>
        h.service.freeze(ID, {
          expectedUpdatedAt: created.updatedAt,
          summary: ' \n ',
        }),
      /requires a summary/,
    );
    const added = await h.service.agendaAdd(ID, {
      content: 'Still open',
      expectedUpdatedAt: created.updatedAt,
    });
    await rejection(
      () => h.service.discard(ID, { expectedUpdatedAt: added.updatedAt }),
      /1\. Still open/,
    );
    await rejection(
      () =>
        h.service.discard(ID, {
          expectedUpdatedAt: added.updatedAt,
          force: true,
        }),
      /requires a reason/,
    );
    await h.service.discard(ID, {
      expectedUpdatedAt: added.updatedAt,
      force: true,
      reason: 'exploration abandoned',
    });
    expect(h.pads.has(ID)).toBe(false);
  });

  test('freeze recovers a persisted marker when artifact creation failed', async () => {
    const h = harness();
    const created = await h.service.create({ project: 'MMR', title: 'Shape' });
    h.failNextCreate();
    await rejection(
      () =>
        h.service.freeze(ID, {
          expectedUpdatedAt: created.updatedAt,
          summary: 'Durable summary',
        }),
      /artifact failure/,
    );
    const staged = await h.service.get(ID);
    expect(staged.freezingAt).not.toBeNull();
    expect(h.creates).toHaveLength(0);

    await h.service.freeze(ID, {
      expectedUpdatedAt: staged.updatedAt,
      summary: 'Durable summary',
    });
    expect(h.creates).toHaveLength(1);
    expect(h.pads.has(ID)).toBe(false);
  });
});
