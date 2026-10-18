import { afterAll, beforeAll, expect, test } from 'bun:test';

import { engineSchemas } from '@mimir/contract';
import type { Engine, EngineInput } from '@mimir/contract';
import {
  annotate,
  attachArtifact,
  createInitiative,
  createProject,
  createScratchpadService,
  createTask,
  depend,
  fileSeed,
  LocalEngine,
  startTask,
} from '@mimir/core';
import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

let fixture: TestStore;
let local: LocalEngine;
let remote: RemoteEngine;
let ids: { artifact: string; initiative: string; ready: string; scratchpad: string; seed: string };

beforeAll(async () => {
  fixture = await createTestStore();
  const { store } = fixture;
  await createProject(store, { key: 'ENG', name: 'Engine' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  const initiative = await createInitiative(store, { projectId: 'ENG', title: 'Reads' });
  const ready = await createTask(store, {
    parentId: initiative.id,
    tags: ['engine'],
    title: 'Ready read',
  });
  const started = await createTask(store, { parentId: initiative.id, title: 'Started read' });
  const awaiting = await createTask(store, { parentId: initiative.id, title: 'Awaiting read' });
  await depend(store, awaiting.id, [ready.id]);
  await annotate(store, started.id, 'Evidence');
  await startTask(store, started.id, { session: 'reads-test' });
  const elsewhere = await createInitiative(store, { projectId: 'OTH', title: 'Elsewhere' });
  await createTask(store, { parentId: elsewhere.id, title: 'Ready read elsewhere' });
  const artifact = await attachArtifact(store, {
    content: 'Frozen body',
    linkNodeIds: [started.id],
    projectId: 'ENG',
    summary: 'Proof of reads',
    tags: ['session_summary'],
    title: 'Read proof',
  });
  const seed = await fileSeed(store, {
    description: 'A rough idea',
    kind: 'idea',
    project: 'ENG',
    requester: 'OTH',
    title: 'Read seeds remotely',
  });
  const scratch = createScratchpadService(store.scratchpads, store.artifacts, store);
  const pad = await scratch.create({ anchors: [started.id], project: 'ENG', title: 'Read pad' });
  await scratch.checkpoint(pad.id, { content: 'First entry', expectedUpdatedAt: pad.updatedAt });
  ids = {
    artifact: artifact.renderedId,
    initiative: initiative.id,
    ready: ready.id,
    scratchpad: pad.id,
    seed: seed.id,
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

afterAll(async () => fixture.close());

type ReadMethod = Exclude<
  {
    [K in keyof Engine]: (typeof engineSchemas)[K]['kind'] extends 'query' ? K : never;
  }[keyof Engine],
  'getNode'
>;
type ReadCase<K extends ReadMethod> = {
  input: () => EngineInput<K>;
  /** Proves the fixture reached the method, so equality is not two empty results. */
  check: (output: Awaited<ReturnType<Engine[K]>>) => void;
};

const reads: { [K in ReadMethod]: ReadCase<K> } = {
  artifacts: {
    check: (set) => {
      expect(set.items.map((item) => item.id)).toEqual([ids.artifact]);
      expect(set.items[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({
      dates: [{ field: 'created_at', op: 'after', value: '2000-01-01' }],
      project: 'ENG',
      timeZone: 'UTC',
    }),
  },
  getArtifact: {
    check: (artifact) => {
      expect(artifact.content).toBe('Frozen body');
      expect(artifact.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({ content: true, id: ids.artifact }),
  },
  getSeed: {
    check: (seed) => {
      expect(seed.description).toBe('A rough idea');
      expect(seed.updatedAt).toBeInstanceOf(Date);
    },
    input: () => ({ content: true, id: ids.seed }),
  },
  list: {
    check: (set) => {
      expect(set.items.map((item) => item.title)).toEqual([
        'Ready read',
        'Started read',
        'Awaiting read',
      ]);
      expect(set.items[0]?.tags?.[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({ facets: ['tags', 'verdicts'], project: 'ENG', status: ['live'] }),
  },
  next: {
    check: (set) => {
      expect(set.items.map((item) => item.id)).toEqual([ids.ready]);
      expect(set.items[0]?.updatedAt).toBeInstanceOf(Date);
    },
    input: () => ({ filters: [{ field: 'title', op: 'has', value: null }], project: 'ENG' }),
  },
  overview: {
    check: (report) => {
      expect(report.inFlight.count).toBe(1);
      expect(report.awaiting.count).toBe(1);
      expect(report.scratchpads.scratchpads[0]?.updatedAt).toBeInstanceOf(Date);
      expect(report.sessions.entries[0]?.from).toBeInstanceOf(Date);
    },
    input: () => ({ asOf: new Date('2100-01-01T00:00:00.000Z'), project: 'ENG' }),
  },
  projects: {
    check: (projects) => {
      expect(projects.map((project) => project.id)).toEqual(['ENG', 'OTH']);
      expect(projects[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({}),
  },
  scratchGet: {
    check: (pad) => {
      expect(pad.journal[0]?.at).toBeInstanceOf(Date);
      expect(pad.freezingAt).toBeNull();
    },
    input: () => ({ id: ids.scratchpad }),
  },
  scratchList: {
    check: (rows) => {
      expect(rows.map((row) => row.id)).toEqual([ids.scratchpad]);
      expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
    },
    input: () => ({ project: 'ENG' }),
  },
  search: {
    check: (set) => {
      expect(set.items.map((hit) => hit.title)).toContain('Ready read');
      expect(set.items[0]?.updatedAt).toBeInstanceOf(Date);
    },
    input: () => ({ project: 'ENG', query: 'read' }),
  },
  seeds: {
    check: (seeds) => {
      expect(seeds.map((seed) => seed.id)).toEqual([ids.seed]);
      expect(seeds[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({ project: 'ENG', requester: 'OTH', timeZone: 'UTC' }),
  },
  status: {
    check: (status) =>
      expect(status.distribution).toEqual({ awaiting: 1, in_progress: 1, ready: 1 }),
    input: () => ({ id: ids.initiative }),
  },
  tree: {
    check: (tree) => {
      expect(tree.children.map((child) => child.title)).toEqual(['Reads']);
      expect(tree.children[0]?.children[0]?.createdAt).toBeInstanceOf(Date);
    },
    input: () => ({ id: 'ENG' }),
  },
};

/** Calls a read by name; the table's typing already ties each input to its method. */
function call(engine: Engine, method: ReadMethod, input: unknown = reads[method].input()) {
  return (Reflect.get(engine, method) as (input: unknown) => Promise<unknown>).call(engine, input);
}

test('the read table names every query method except the wedge-proven getNode', () => {
  const queries = Object.entries(engineSchemas)
    .filter(([, schema]) => schema.kind === 'query')
    .map(([name]) => name)
    .filter((name) => name !== 'getNode');
  expect(Object.keys(reads).toSorted()).toEqual(queries.toSorted());
});

test.each(Object.keys(reads) as ReadMethod[])(
  '%s returns the same values, with Date instants, locally and remotely',
  async (method) => {
    const expected = await call(local, method);
    const actual = await call(remote, method);
    expect(actual).toEqual(expected);
    (reads[method].check as (output: unknown) => void)(actual);
  },
);

const boardReads: ReadMethod[] = [
  'next',
  'list',
  'overview',
  'artifacts',
  'search',
  'seeds',
  'scratchList',
];

test.each(boardReads)('%s refuses a read with no project, on both Engines', async (method) => {
  const { project: _project, ...unscoped } = reads[method].input() as { project?: string };
  const run = (engine: Engine) => errorOf(call(engine, method, unscoped));
  const [localError, remoteError] = [await run(local), await run(remote)];
  expect(localError.code).toBe('validation');
  expect(remoteError.code).toBe('validation');
  expect(remoteError.message).toBe(localError.message);
});

test('board reads stay inside the named project', async () => {
  const next = await remote.next({ project: 'OTH' });
  expect(next.items.map((item) => item.title)).toEqual(['Ready read elsewhere']);
  expect((await remote.seeds({ project: 'OTH' })).length).toBe(0);
  expect((await remote.scratchList({ project: 'OTH' })).length).toBe(0);
  expect((await remote.artifacts({ project: 'OTH' })).total).toBe(0);
});

test.each([
  ['getArtifact', { id: 'ENG-a99' }],
  ['getSeed', { id: 'ENG-s99' }],
  ['scratchGet', { id: '00000000-0000-4000-8000-000000000000' }],
  ['status', { id: 'ENG-99' }],
  ['tree', { id: 'ENG-99' }],
  ['overview', { project: 'NOPE' }],
] as const)('%s keeps the not_found refusal across the wire', async (method, input) => {
  const run = (engine: Engine) => errorOf(call(engine, method, input));
  const [localError, remoteError] = [await run(local), await run(remote)];
  expect(localError.code).toBe('not_found');
  expect(remoteError.code).toBe('not_found');
  expect(remoteError.message).toBe(localError.message);
  expect(remoteError.hint).toBe(localError.hint);
});
