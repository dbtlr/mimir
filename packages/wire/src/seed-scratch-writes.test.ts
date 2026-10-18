import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { engineSchemas } from '@mimir/contract';
import type { Engine, EngineInput, EngineMethods, ErrorCode } from '@mimir/contract';
import {
  archiveProject,
  createInitiative,
  createProject,
  createScratchpadService,
  createTask,
  fileSeed,
  LocalEngine,
} from '@mimir/core';
import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

/**
 * The Seed and Scratchpad writes (MMR-518). Node writes and uniform verbs (MMR-517)
 * are proved in writes.test.ts, so this file takes only the `seed*`, `scratch*`,
 * and `triage` mutations.
 */
type WriteMethod = Extract<
  {
    [K in keyof EngineMethods]: (typeof engineSchemas)[K]['kind'] extends 'mutation' ? K : never;
  }[keyof EngineMethods],
  `seed${string}` | `scratch${string}` | 'triage'
>;
const SEED_SCRATCH_WRITE = /^(?:seed|scratch)[A-Z]|^triage$/;
const WRITE_METHODS = Object.entries(engineSchemas)
  .filter(([name, schema]) => schema.kind === 'mutation' && SEED_SCRATCH_WRITE.test(name))
  .map(([name]) => name as WriteMethod);

let fixture: TestStore;
let local: LocalEngine;
let remote: RemoteEngine;
let ids: { archivedPad: string; initiative: string; pad: string; seed: string; task: string };

beforeEach(async () => {
  fixture = await createTestStore();
  const { store } = fixture;
  await createProject(store, { key: 'ENG', name: 'Engine' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  const initiative = await createInitiative(store, { projectId: 'ENG', title: 'Writes' });
  const task = await createTask(store, { parentId: initiative.id, title: 'Existing work' });
  const seed = await fileSeed(store, {
    description: 'A rough idea',
    kind: 'idea',
    project: 'ENG',
    requester: 'OTH',
    title: 'Write seeds remotely',
  });
  const scratch = createScratchpadService(store.scratchpads, store.artifacts, store);
  const pad = await scratch.create({ anchors: [task.id], project: 'ENG', title: 'Write pad' });
  await createProject(store, { key: 'ARC', name: 'Archived' });
  const archivedPad = await scratch.create({ project: 'ARC', title: 'Archived pad' });
  await archiveProject(store, 'ARC');
  ids = {
    archivedPad: archivedPad.id,
    initiative: initiative.id,
    pad: pad.id,
    seed: seed.id,
    task: task.id,
  };
  local = new LocalEngine(store);
  const handle = createEngineHandler(local);
  remote = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    url: 'http://engine.test/trpc',
  });
});

afterEach(async () => fixture.close());

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Every string anywhere in an output that still looks like an ISO instant. */
function isoStrings(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return ISO_INSTANT.test(value) ? [path] : [];
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([key, item]) => isoStrings(item, `${path}.${key}`));
  }
  return [];
}

/** The guard a client echoes: the Scratchpad's last-read `updatedAt`. */
async function guard(id = ids.pad) {
  return (await local.scratchGet({ id })).updatedAt;
}

/** Adds one open Agenda item through the local Engine so a later write can settle it. */
async function addAgendaItem() {
  await local.scratchAgendaAdd({ content: 'Item', expectedUpdatedAt: await guard(), id: ids.pad });
}

type WriteCase<K extends WriteMethod> = {
  input: () => Promise<EngineInput<K>>;
  /** Proves the write reached the method, so equality is not two empty results. */
  check: (output: Awaited<ReturnType<Engine[K]>>) => void;
  /** Reads the written record through an Engine; absent when the write leaves nothing to read. */
  readBack?: (engine: Engine, output: Awaited<ReturnType<Engine[K]>>) => Promise<unknown>;
  /** The read-back is a different projection than the write's output. */
  differs?: boolean;
};

const readPad = (engine: Engine, pad: { id: string }) => engine.scratchGet({ id: pad.id });
const readSeed = (engine: Engine, seed: { id: string }) =>
  engine.getSeed({ content: true, id: seed.id });

const writes: { [K in WriteMethod]: WriteCase<K> } = {
  scratchAgendaAdd: {
    check: (pad) => expect(pad.agenda.map((item) => item.content)).toEqual(['Ship it']),
    input: async () => ({ content: 'Ship it', expectedUpdatedAt: await guard(), id: ids.pad }),
    readBack: readPad,
  },
  scratchAgendaComplete: {
    check: (pad) => expect(pad.agenda[0]?.state).toBe('done'),
    input: async () => {
      await addAgendaItem();
      return { expectedUpdatedAt: await guard(), id: ids.pad, number: 1 };
    },
    readBack: readPad,
  },
  scratchAgendaSupersede: {
    check: (pad) => {
      expect(pad.agenda[0]?.state).toBe('superseded');
      expect(pad.agenda[0]?.reason).toBe('Overtaken');
    },
    input: async () => {
      await addAgendaItem();
      return { expectedUpdatedAt: await guard(), id: ids.pad, number: 1, reason: 'Overtaken' };
    },
    readBack: readPad,
  },
  scratchCheckpoint: {
    check: (pad) => {
      expect(pad.journal.map((entry) => entry.content)).toEqual(['Progress']);
      expect(pad.journal[0]?.at).toBeInstanceOf(Date);
    },
    input: async () => ({ content: 'Progress', expectedUpdatedAt: await guard(), id: ids.pad }),
    readBack: readPad,
  },
  scratchCreate: {
    check: (pad) => {
      expect(pad.title).toBe('Fresh pad');
      expect(pad.anchors).toEqual([ids.task]);
      expect(pad.createdAt).toBeInstanceOf(Date);
    },
    input: async () => ({ anchors: [ids.task], project: 'ENG', title: 'Fresh pad' }),
    readBack: readPad,
  },
  scratchDiscard: {
    check: (result) => expect(result).toEqual({ id: ids.pad, result: 'discarded' }),
    input: async () => ({ expectedUpdatedAt: await guard(), id: ids.pad }),
  },
  scratchFreeze: {
    check: (artifact) => {
      expect(artifact.summary).toBe('Frozen for review');
      expect(artifact.tags).toEqual(['proof', 'scratchpad']);
      expect(artifact.createdAt).toBeInstanceOf(Date);
      expect(artifact.title).toBe('Write pad');
    },
    input: async () => ({
      expectedUpdatedAt: await guard(),
      id: ids.pad,
      summary: 'Frozen for review',
      tags: ['proof'],
    }),
    readBack: (engine, artifact) => engine.getArtifact({ content: true, id: artifact.id }),
  },
  scratchUpdate: {
    check: (pad) => {
      expect(pad.title).toBe('Renamed pad');
      expect(pad.anchors).toEqual([]);
    },
    input: async () => ({
      anchors: [],
      expectedUpdatedAt: await guard(),
      id: ids.pad,
      title: 'Renamed pad',
    }),
    readBack: readPad,
  },
  seedCreate: {
    check: (seed) => {
      expect(seed.title).toBe('Capture remotely');
      expect(seed.requester).toBe('OTH');
      expect(seed.createdAt).toBeInstanceOf(Date);
    },
    input: async () => ({
      description: 'Details',
      kind: 'bug',
      project: 'ENG',
      requester: 'OTH',
      title: 'Capture remotely',
    }),
    readBack: readSeed,
  },
  seedPark: {
    check: (seed) => expect(seed.lifecycle).toBe('parked'),
    input: async () => ({ id: ids.seed, reason: 'Later' }),
    readBack: readSeed,
  },
  seedPromote: {
    check: (promotion) => {
      expect(promotion.seed.lifecycle).toBe('promoted');
      expect(promotion.created).toBe(promotion.spawnedId);
      expect(promotion.seed.spawned).toEqual([promotion.spawnedId]);
    },
    differs: true,
    input: async () => ({ id: ids.seed, parent: ids.initiative, priority: 'p1', tags: ['seeded'] }),
    readBack: (engine, promotion) => readSeed(engine, promotion.seed),
  },
  seedReject: {
    check: (seed) => expect(seed.lifecycle).toBe('rejected'),
    input: async () => ({ id: ids.seed, reason: 'Not now' }),
    readBack: readSeed,
  },
  seedResolve: {
    check: (seed) => expect(seed.lifecycle).toBe('resolved'),
    input: async () => ({ id: ids.seed, reason: 'Done elsewhere' }),
    readBack: readSeed,
  },
  seedUnpark: {
    check: (seed) => expect(seed.lifecycle).toBe('new'),
    input: async () => {
      await local.seedPark({ id: ids.seed });
      return { id: ids.seed };
    },
    readBack: readSeed,
  },
  seedUpdate: {
    check: (seed) => {
      expect(seed.title).toBe('Retitled');
      expect(seed.kind).toBe('feature');
      expect(seed.description).toBeNull();
    },
    input: async () => ({ description: null, id: ids.seed, kind: 'feature', title: 'Retitled' }),
    readBack: readSeed,
  },
  triage: {
    check: (report) => {
      expect(report.board).toBe('ENG');
      expect(report.untriaged.map((seed) => seed.id)).toEqual([ids.seed]);
      expect(report.untriaged[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: async () => ({ board: 'ENG', dryRun: true }),
  },
};

/** Calls a write by name; the table's typing already ties each input to its method. */
function call(engine: Engine, method: WriteMethod, input: unknown) {
  return (Reflect.get(engine, method) as (input: unknown) => Promise<unknown>).call(engine, input);
}

test('the write table names every mutation the schemas declare, except done', () => {
  expect(Object.keys(writes).toSorted()).toEqual([...WRITE_METHODS].toSorted());
});

describe.each([
  ['remote', 'local'],
  ['local', 'remote'],
] as const)('a write through the %s Engine is read back by the %s Engine', (writer, reader) => {
  test.each([...WRITE_METHODS])('%s', async (method) => {
    const engines = { local, remote };
    const writeCase = writes[method] as WriteCase<WriteMethod>;
    const output = await call(engines[writer], method, await writeCase.input());
    expect(isoStrings(output)).toEqual([]);
    writeCase.check(output as never);
    if (writeCase.readBack !== undefined) {
      const readBack = await writeCase.readBack(engines[reader], output as never);
      expect(isoStrings(readBack)).toEqual([]);
      if (writeCase.differs !== true) {
        expect(readBack).toStrictEqual(output);
      }
      expect(readBack).toStrictEqual(await writeCase.readBack(engines[writer], output as never));
    }
  });
});

test('a discarded Scratchpad is gone for both Engines', async () => {
  await remote.scratchDiscard({ expectedUpdatedAt: await guard(), id: ids.pad });
  expect((await errorOf(local.scratchGet({ id: ids.pad }))).code).toBe('not_found');
  expect((await errorOf(remote.scratchGet({ id: ids.pad }))).code).toBe('not_found');
});

test('triage annotates a resolved upstream once, whichever Engine runs it', async () => {
  const asks = await createInitiative(fixture.store, { projectId: 'OTH', title: 'Asks' });
  const waiting = await createTask(fixture.store, {
    parentId: asks.id,
    title: 'Waiting on ENG',
    upstream: ids.seed,
  });
  await remote.seedResolve({ id: ids.seed, reason: 'Shipped' });
  const dry = await remote.triage({ board: 'OTH', dryRun: true });
  expect(dry).toStrictEqual(await local.triage({ board: 'OTH', dryRun: true }));
  expect(dry.upstreamResolutions).toMatchObject([
    { alreadyRecorded: false, annotated: false, reason: 'Shipped', task: waiting.id },
  ]);
  const written = await remote.triage({ board: 'OTH' });
  expect(written.upstreamResolutions[0]?.annotated).toBe(true);
  const again = await local.triage({ board: 'OTH' });
  expect(again.upstreamResolutions[0]).toMatchObject({ alreadyRecorded: true, annotated: false });
});

test('a forced discard drops a Scratchpad with an open Agenda item, whichever Engine runs it', async () => {
  await addAgendaItem();
  expect(
    await remote.scratchDiscard({
      expectedUpdatedAt: await guard(),
      force: true,
      id: ids.pad,
      reason: 'Abandoned',
    }),
  ).toEqual({ id: ids.pad, result: 'discarded' });
  expect((await errorOf(local.scratchGet({ id: ids.pad }))).code).toBe('not_found');
});

test('a promoted seed spawns a task carrying the priority and tags given', async () => {
  const promotion = await remote.seedPromote({
    id: ids.seed,
    parent: ids.initiative,
    priority: 'p1',
    tags: ['seeded'],
  });
  const node = await local.getNode({ id: promotion.spawnedId });
  expect(node.priority).toBe('p1');
  expect(node.tags?.map((entry) => entry.tag)).toEqual(['seeded']);
});

test('retrying a freeze after its project is archived reads as absent on both Engines', async () => {
  const { store } = fixture;
  await createProject(store, { key: 'REC', name: 'Recovered' });
  const scratch = createScratchpadService(store.scratchpads, store.artifacts, store);
  const pad = await scratch.create({ project: 'REC', title: 'Frozen pad' });
  const request = { expectedUpdatedAt: new Date(0), id: pad.id, summary: 'x' };
  await scratch.freeze(pad.id, { expectedUpdatedAt: pad.updatedAt, summary: 'x' });
  await archiveProject(store, 'REC');
  for (const engine of [local, remote]) {
    expect((await errorOf(engine.scratchFreeze(request))).code).toBe('not_found');
  }
});

const refusals: [string, WriteMethod, () => Promise<unknown>, ErrorCode][] = [
  [
    'a stale Scratchpad guard',
    'scratchCheckpoint',
    async () => ({
      content: 'Late',
      expectedUpdatedAt: new Date('2000-01-01T00:00:00.000Z'),
      id: ids.pad,
    }),
    'validation',
  ],
  [
    'a missing Scratchpad',
    'scratchAgendaAdd',
    async () => ({
      content: 'x',
      expectedUpdatedAt: new Date(),
      id: '00000000-0000-4000-8000-000000000000',
    }),
    'not_found',
  ],
  [
    'a Scratchpad in an archived project',
    'scratchCheckpoint',
    async () => ({ content: 'x', expectedUpdatedAt: new Date(), id: ids.archivedPad }),
    'not_found',
  ],
  [
    'freezing a Scratchpad in an archived project',
    'scratchFreeze',
    async () => ({ expectedUpdatedAt: new Date(), id: ids.archivedPad, summary: 'x' }),
    'not_found',
  ],
  [
    'discarding a Scratchpad in an archived project',
    'scratchDiscard',
    async () => ({ expectedUpdatedAt: new Date(), id: ids.archivedPad }),
    'not_found',
  ],
  [
    'updating a Scratchpad in an archived project',
    'scratchUpdate',
    async () => ({ expectedUpdatedAt: new Date(), id: ids.archivedPad, title: 'x' }),
    'not_found',
  ],
  [
    'discarding a Scratchpad with an open Agenda item',
    'scratchDiscard',
    async () => {
      await addAgendaItem();
      return { expectedUpdatedAt: await guard(), id: ids.pad };
    },
    'validation',
  ],
  [
    'a forced discard without a reason',
    'scratchDiscard',
    async () => {
      await addAgendaItem();
      return { expectedUpdatedAt: await guard(), force: true, id: ids.pad };
    },
    'validation',
  ],
  [
    'a Scratchpad created in an archived project',
    'scratchCreate',
    async () => ({ project: 'ARC', title: 'Nope' }),
    'conflict',
  ],
  [
    'an Agenda item that does not exist',
    'scratchAgendaComplete',
    async () => ({ expectedUpdatedAt: await guard(), id: ids.pad, number: 9 }),
    'not_found',
  ],
  [
    'a supersede without a reason',
    'scratchAgendaSupersede',
    async () => ({ expectedUpdatedAt: await guard(), id: ids.pad, number: 1, reason: ' ' }),
    'validation',
  ],
  [
    'a Scratchpad project that is not a bare key',
    'scratchCreate',
    async () => ({ project: 'all', title: 'Nope' }),
    'validation',
  ],
  ['a seed that does not exist', 'seedPark', async () => ({ id: 'ENG-s99' }), 'not_found'],
  [
    'a seed filed on a lowercase project',
    'seedCreate',
    async () => ({ kind: 'idea', project: 'eng', title: 'Nope' }),
    'validation',
  ],
  [
    'a seed filed on an unknown project',
    'seedCreate',
    async () => ({ kind: 'idea', project: 'ZZZ', title: 'Nope' }),
    'not_found',
  ],
  [
    'a resolve without a reason',
    'seedResolve',
    async () => ({ id: ids.seed, reason: ' ' }),
    'validation',
  ],
  [
    'a promote with neither parent nor link',
    'seedPromote',
    async () => ({ id: ids.seed }),
    'validation',
  ],
  ['a triage of every board', 'triage', async () => ({ board: 'all' }), 'validation'],
  ['a triage with no board', 'triage', async () => ({}), 'validation'],
];

describe.each(refusals)('refusing %s', (_label, method, input, code) => {
  test(`${method} fails with ${code} and the same message on both Engines`, async () => {
    const request = await input();
    const localError = await errorOf(call(local, method, request));
    const remoteError = await errorOf(call(remote, method, request));
    expect(localError.code).toBe(code);
    expect(remoteError.code).toBe(code);
    expect(remoteError.message).toBe(localError.message);
    expect(remoteError.hint).toBe(localError.hint);
  });
});
