import { afterAll, beforeAll, expect, test } from 'bun:test';

import { createApiHandler } from '@mimir/api';
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
  overviewToWire,
  reviewToWire,
  startTask,
  submitTask,
  workToWire,
} from '@mimir/core';
import type { DoctorFacet } from '@mimir/core';
import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { RemoteEngine } from '@mimir/wire/client';
import { createEngineHandler } from '@mimir/wire/server';

/**
 * Each `console.*` method, mapped back to wire form, equals the body its /api
 * route serves for the same store. Local and remote Engines agree too.
 */

let fixture: TestStore;
let local: LocalEngine;
let remote: RemoteEngine;
let api: (path: string) => Promise<Response>;
let ids: { initiative: string; phase: string; submitted: string };

const doctor = async (): Promise<DoctorFacet> => ({
  ...emptyDoctorFacet(),
  finding_total: 2,
  groups: [{ finding_count: 2, project: 'ENG', records: [] }],
});

beforeAll(async () => {
  fixture = await createTestStore();
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
  await fileSeed(store, { kind: 'idea', project: 'OTH', title: 'Untriaged idea' });
  ids = { initiative: initiative.id, phase: phase.id, submitted: submitted.id };
  local = new LocalEngine(store, { findings: findingsProviderOf(doctor) });
  const handle = createEngineHandler(local);
  remote = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    url: 'http://engine.test/trpc',
  });
  const handler = createApiHandler(store, { doctor, version: 'test' });
  api = async (path) => handler(new Request(new URL(path, 'http://api.test')));
});

afterAll(async () => fixture.close());

/** An Engine output back in the string-valued form core hands the wire mappers. */
const asCore = (output: unknown): any =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps Dates; the wire mappers need ISO strings
  JSON.parse(JSON.stringify(output));

type Case = {
  name: string;
  engine: (engine: ConsoleEngine) => Promise<unknown>;
  route: string;
  wire: (output: unknown) => unknown;
};

const cases: Case[] = [
  {
    engine: (engine) => engine.review({ timeZone: 'UTC' }),
    name: 'review',
    route: '/api/review?tz=UTC',
    wire: (output) => reviewToWire(asCore(output)),
  },
  {
    engine: (engine) => engine.projectWork({ project: 'ENG', timeZone: 'UTC' }),
    name: 'projectWork',
    route: '/api/projects/ENG/work?tz=UTC',
    wire: (output) => workToWire(asCore(output)),
  },
  {
    engine: (engine) => engine.nodeWork({ id: 'ENG-1', timeZone: 'UTC' }),
    name: 'nodeWork on an initiative',
    route: '/api/nodes/ENG-1/work?tz=UTC',
    wire: (output) => workToWire(asCore(output)),
  },
  {
    engine: (engine) => engine.nodeWork({ id: 'ENG-2', timeZone: 'UTC' }),
    name: 'nodeWork on a phase',
    route: '/api/nodes/ENG-2/work?tz=UTC',
    wire: (output) => workToWire(asCore(output)),
  },
  {
    engine: (engine) => engine.overview({ project: 'ENG' }),
    name: 'overview',
    route: '/api/projects/ENG/overview',
    wire: (output) => overviewToWire(asCore(output)),
  },
];

test.each(cases)('console.$name equals its /api body, locally and remotely', async (c) => {
  const body: unknown = await (await api(c.route)).json();
  const [fromLocal, fromRemote] = [await c.engine(local.console), await c.engine(remote.console)];
  expect(c.wire(fromLocal)).toEqual(body);
  expect(c.wire(fromRemote)).toEqual(body);
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

type Refusal = [string, (engine: ConsoleEngine) => Promise<unknown>, string, number];
const refusals: Refusal[] = [
  ['review without a time zone', (e) => e.review({}), '/api/review', 400],
  [
    'review with an unknown zone',
    (e) => e.review({ timeZone: 'Mars/Olympus' }),
    '/api/review?tz=Mars/Olympus',
    400,
  ],
  [
    'projectWork on a task',
    (e) => e.projectWork({ project: 'ENG-3', timeZone: 'UTC' }),
    '/api/projects/ENG-3/work?tz=UTC',
    400,
  ],
  [
    'projectWork on an unknown project',
    (e) => e.projectWork({ project: 'NOPE', timeZone: 'UTC' }),
    '/api/projects/NOPE/work?tz=UTC',
    404,
  ],
  [
    'nodeWork on a project key',
    (e) => e.nodeWork({ id: 'ENG', timeZone: 'UTC' }),
    '/api/nodes/ENG/work?tz=UTC',
    400,
  ],
  [
    'nodeWork on an unknown node',
    (e) => e.nodeWork({ id: 'ENG-99', timeZone: 'UTC' }),
    '/api/nodes/ENG-99/work?tz=UTC',
    404,
  ],
  [
    'overview on a non-project',
    (e) => e.overview({ project: 'ENG-3' }),
    '/api/projects/ENG-3/overview',
    400,
  ],
  [
    'overview on an unknown project',
    (e) => e.overview({ project: 'NOPE' }),
    '/api/projects/NOPE/overview',
    404,
  ],
];

test.each(refusals)('%s is refused like its route', async (_name, run, route, status) => {
  const response = await api(route);
  expect(response.status).toBe(status);
  const wireError = ((await response.json()) as { error: { code: string; message: string } }).error;
  const [localError, remoteError] = [
    await errorOf(run(local.console)),
    await errorOf(run(remote.console)),
  ];
  expect<string>(localError.code).toBe(wireError.code);
  expect(localError.message).toBe(wireError.message);
  expect(remoteError.code).toBe(localError.code);
  expect(remoteError.message).toBe(localError.message);
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
