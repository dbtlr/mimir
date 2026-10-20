import { afterAll, beforeAll, expect, test } from 'bun:test';

import type { ConsoleEngine, ConsoleInput } from '@mimir/contract';
import {
  annotate,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  emptyDoctorFacet,
  fileSeed,
  findingsProviderOf,
  LocalEngine,
  startTask,
  submitTask,
} from '@mimir/core';
import type { DoctorFacet } from '@mimir/core';
import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { RemoteEngine } from '@mimir/wire/client';
import { createEngineHandler } from '@mimir/wire/server';

/**
 * Each `console.*` method answers the same through the local Engine and the
 * remote one over tRPC, and refuses bad input the same way.
 */

let fixture: TestStore;
let authorization: string;
let local: LocalEngine;
let remote: RemoteEngine;
let ids: { initiative: string; phase: string; submitted: string };

const doctor = async (): Promise<DoctorFacet> => ({
  ...emptyDoctorFacet(),
  finding_total: 2,
  groups: [{ finding_count: 2, project: 'ENG', records: [] }],
});

beforeAll(async () => {
  fixture = await createTestStore();
  const credential = await fixture.tokens.redeem(await fixture.tokens.issueCode('wire-fixture'));
  if (credential === null) {
    throw new Error('fixture pairing failed');
  }
  authorization = `Bearer ${credential.token}`;
  const { store } = fixture;
  await createProject(store, { key: 'ENG', name: 'Engine' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  const initiative = await createInitiative(store, { projectId: 'ENG', title: 'Console' });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'Views' });
  const submitted = await createTask(store, { parentId: phase.id, title: 'Under review' });
  const started = await createTask(store, { parentId: phase.id, title: 'Started' });
  const ready = await createTask(store, { parentId: phase.id, title: 'Ready' });
  const awaiting = await createTask(store, { parentId: phase.id, title: 'Awaiting' });
  const blocked = await createTask(store, { parentId: phase.id, title: 'Blocked' });
  const done = await createTask(store, { parentId: phase.id, title: 'Done' });
  await depend(store, awaiting.id, [ready.id]);
  await startTask(store, submitted.id);
  await submitTask(store, submitted.id);
  await annotate(store, started.id, 'A note');
  await startTask(store, started.id, { session: 'console-test' });
  await blockTask(store, blocked.id, 'waiting on a key', 'you');
  await startTask(store, done.id);
  await completeTask(store, done.id);
  const elsewhere = await createInitiative(store, { projectId: 'OTH', title: 'Elsewhere' });
  await createTask(store, { parentId: elsewhere.id, title: 'Ready elsewhere' });
  const idea = await fileSeed(store, { kind: 'idea', project: 'OTH', title: 'Untriaged idea' });
  // Work on two boards names the idea as its upstream, one task already settled.
  await createTask(store, { parentId: phase.id, title: 'Waits on the idea', upstream: idea.id });
  const settled = await createTask(store, {
    parentId: elsewhere.id,
    title: 'Settled on the idea',
    upstream: idea.id,
  });
  await startTask(store, settled.id);
  await completeTask(store, settled.id);
  ids = { initiative: initiative.id, phase: phase.id, submitted: submitted.id };
  local = new LocalEngine(store, { findings: findingsProviderOf(doctor) });
  const handle = createEngineHandler(local, {
    verifyToken: fixture.tokens.verify,
    version: '0.26.0',
  });
  remote = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version: '0.26.0',
  });
});

afterAll(async () => fixture.close());

type Case = { name: string; engine: (engine: ConsoleEngine) => Promise<unknown> };

const cases: Case[] = [
  { engine: (engine) => engine.review({ timeZone: 'UTC' }), name: 'review' },
  {
    engine: (engine) => engine.projectWork({ project: 'ENG', timeZone: 'UTC' }),
    name: 'projectWork',
  },
  {
    engine: (engine) => engine.nodeWork({ id: 'ENG-1', timeZone: 'UTC' }),
    name: 'nodeWork on an initiative',
  },
  {
    engine: (engine) => engine.nodeWork({ id: 'ENG-2', timeZone: 'UTC' }),
    name: 'nodeWork on a phase',
  },
  { engine: (engine) => engine.overview({ project: 'ENG' }), name: 'overview' },
  { engine: (engine) => engine.search({ query: 'Ready' }), name: 'search across every project' },
  {
    engine: (engine) => engine.search({ project: 'OTH', query: 'Ready' }),
    name: 'search ranking the current project first',
  },
  { engine: (engine) => engine.search({ query: 'ENG-3' }), name: 'search by id' },
  {
    engine: (engine) => engine.upstreamTasks({ seed: 'OTH-s1' }),
    name: 'upstreamTasks across every board',
  },
  {
    engine: (engine) => engine.upstreamTasks({ seed: 'OTH-s99' }),
    name: 'upstreamTasks of a seed nothing names',
  },
  {
    engine: (engine) => engine.openTasks({ q: 'ready' }),
    name: 'openTasks by title across every board',
  },
  { engine: (engine) => engine.openTasks({ q: 'ENG-3' }), name: 'openTasks by id' },
  { engine: (engine) => engine.openTasks({ q: 'done' }), name: 'openTasks of only finished work' },
];

test.each(cases)('console.$name answers the same locally and remotely', async (c) => {
  expect(await c.engine(remote.console)).toEqual(await c.engine(local.console));
});

test('the fixture reaches every section the pages show', async () => {
  const review = await remote.console.review({ timeZone: 'UTC' });
  expect(review.decisions.map((group) => group.project.key)).toEqual(['ENG']);
  expect(review.queue).toContain(ids.submitted);
  expect(review.now[0]?.startedAt).toBeInstanceOf(Date);
  expect(review.shipped[0]?.finishedAt).toBeInstanceOf(Date);
  expect(review.triage.map((group) => group.project.key).toSorted()).toEqual(['ENG', 'OTH']);
  const work = await remote.console.projectWork({ project: 'ENG', timeZone: 'UTC' });
  expect(work.now[0]?.latestNote?.createdAt).toBeInstanceOf(Date);
  expect(work.frontier.toGroom.length).toBeGreaterThan(0);
  const open = await remote.console.openTasks({ q: 'ready' });
  expect(open.items.map((task) => task.title).toSorted()).toEqual(['Ready', 'Ready elsewhere']);
  expect((await remote.console.openTasks({ q: 'done' })).items).toEqual([]);
  const upstream = await remote.console.upstreamTasks({ seed: 'OTH-s1' });
  expect(upstream.items.map((task) => task.title).toSorted()).toEqual([
    'Settled on the idea',
    'Waits on the idea',
  ]);
});

test('console.openTasks finds an old open task that newer matching records crowd out of a search', async () => {
  const crowded = await createTestStore();
  try {
    const { store } = crowded;
    await createProject(store, { key: 'CRW', name: 'Crowded' });
    await createProject(store, { key: 'AAA', name: 'Ideas' });
    const home = await createInitiative(store, { projectId: 'CRW', title: 'Home' });
    const old = await createTask(store, { parentId: home.id, title: 'Old review chore' });
    // Every newer record also matches. The search ranks them ahead of the task:
    // newer first, and by id when the instants tie.
    for (let n = 0; n < 101; n++) {
      await fileSeed(store, { kind: 'idea', project: 'AAA', title: `Review idea ${n}` });
    }
    const engine = new LocalEngine(store).console;
    const hits = await engine.search({ limit: 100, query: 'review' });
    expect(hits.items.map((hit) => hit.id)).not.toContain(old.id);
    expect((await engine.openTasks({ q: 'review' })).items.map((task) => task.id)).toEqual([
      old.id,
    ]);
  } finally {
    await crowded.close();
  }
});

test('the review page counts the findings the host supplies, and none without a provider', async () => {
  const withFindings = await remote.console.review({ timeZone: 'UTC' });
  expect(withFindings.triage.find((group) => group.project.key === 'ENG')?.findings).toBe(2);
  const bare = await new LocalEngine(fixture.store).console.review({ timeZone: 'UTC' });
  expect(bare.triage.find((group) => group.project.key === 'ENG')).toBeUndefined();
});

test('a failing findings provider counts no findings instead of failing the page', async () => {
  const failing = new LocalEngine(fixture.store, {
    findings: () => Promise.reject(new Error('scan failed')),
  });
  const original = console.error;
  console.error = () => {};
  try {
    expect((await failing.console.review({ timeZone: 'UTC' })).projects.length).toBe(2);
  } finally {
    console.error = original;
  }
});

type Refusal = [name: string, run: (engine: ConsoleEngine) => Promise<unknown>, code: string];
const refusals: Refusal[] = [
  ['review without a time zone', (e) => e.review({}), 'validation'],
  ['review with an unknown zone', (e) => e.review({ timeZone: 'Mars/Olympus' }), 'validation'],
  [
    'projectWork on a task',
    (e) => e.projectWork({ project: 'ENG-3', timeZone: 'UTC' }),
    'validation',
  ],
  [
    'projectWork on an unknown project',
    (e) => e.projectWork({ project: 'NOPE', timeZone: 'UTC' }),
    'not_found',
  ],
  ['nodeWork on a project key', (e) => e.nodeWork({ id: 'ENG', timeZone: 'UTC' }), 'validation'],
  [
    'nodeWork on an unknown node',
    (e) => e.nodeWork({ id: 'ENG-99', timeZone: 'UTC' }),
    'not_found',
  ],
  ['overview on a non-project', (e) => e.overview({ project: 'ENG-3' }), 'validation'],
  ['overview on an unknown project', (e) => e.overview({ project: 'NOPE' }), 'not_found'],
  ['search without a query', (e) => e.search({ query: ' ' }), 'validation'],
  [
    'search ranking an unknown project',
    (e) => e.search({ project: 'NOPE', query: 'Ready' }),
    'not_found',
  ],
];

test.each(refusals)(
  '%s is refused with the same domain error locally and remotely',
  async (_name, run, code) => {
    const [localError, remoteError] = [
      await errorOf(run(local.console)),
      await errorOf(run(remote.console)),
    ];
    expect<string>(localError.code).toBe(code);
    expect(remoteError.code).toBe(localError.code);
    expect(remoteError.message).toBe(localError.message);
  },
);

test('console.search refuses an empty or "all" project instead of reading it as unset', async () => {
  for (const project of ['', 'all']) {
    const refusal = await errorOf(remote.console.search({ project, query: 'Ready' }));
    expect<string>(refusal.code).toBe('not_found');
  }
});

test('the as-of input places staleness far in the future', async () => {
  const input: ConsoleInput<'review'> = {
    asOf: new Date('2100-01-01T00:00:00.000Z'),
    timeZone: 'UTC',
  };
  const later = await remote.console.review(input);
  expect(later.goingCold.length).toBeGreaterThan(0);
});

test('the as-of input reaches the work pages and the overview', async () => {
  const asOf = new Date('2100-01-01T00:00:00.000Z');
  const now = [
    await remote.console.projectWork({ project: 'ENG', timeZone: 'UTC' }),
    await remote.console.nodeWork({ id: 'ENG-1', timeZone: 'UTC' }),
    await remote.console.overview({ project: 'ENG' }),
  ];
  const later = [
    await remote.console.projectWork({ asOf, project: 'ENG', timeZone: 'UTC' }),
    await remote.console.nodeWork({ asOf, id: 'ENG-1', timeZone: 'UTC' }),
    await remote.console.overview({ asOf, project: 'ENG' }),
  ];
  for (const [index, view] of now.entries()) {
    expect(JSON.stringify(later[index])).not.toBe(JSON.stringify(view));
  }
});
