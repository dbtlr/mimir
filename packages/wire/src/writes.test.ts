import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { engineSchemas, OP_FACTS, UNIFORM_VERBS, HANDLE_FIELD_ARGS } from '@mimir/contract';
import type { Engine, EngineInput, EngineMethods } from '@mimir/contract';
import {
  annotate,
  archiveProject,
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  fileSeed,
  LocalEngine,
  parkSeed,
  parkTask,
  queueTask,
  startTask,
  submitTask,
  tagEntities,
} from '@mimir/core';
import { createTestStore, errorOf, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

/**
 * Every write is run against two identical stores, once through `LocalEngine`
 * and once through `RemoteEngine` over the real router, with the clock frozen
 * so stamped instants match. The outputs must be strictly equal.
 */

type Ids = {
  blockedTask: string;
  doneTask: string;
  initiative: string;
  otherPhase: string;
  parkedSeed: string;
  parkedTask: string;
  phase: string;
  queuedTask: string;
  reviewTask: string;
  seed: string;
  startedTask: string;
  taggedTask: string;
  todoTask: string;
  waitingTask: string;
};

type Fixture = { close: () => Promise<void>; ids: Ids; local: LocalEngine; remote: RemoteEngine };

/** A store holding every state a write can start from; ids are deterministic per build. */
async function buildFixture(): Promise<Fixture> {
  const fixture: TestStore = await createTestStore();
  const authorization = `Bearer ${await pairTestDevice(fixture.tokens, 'wire-fixture')}`;
  const { store } = fixture;
  await createProject(store, { key: 'ENG', name: 'Engine' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  await createProject(store, { key: 'ARC', name: 'Archived' });
  await archiveProject(store, 'ARC');
  const initiative = await createInitiative(store, { projectId: 'ENG', title: 'Writes' });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase one' });
  const otherPhase = await createPhase(store, { parentId: initiative.id, title: 'Phase two' });
  const task = (title: string, extra: { tags?: string[] } = {}) =>
    createTask(store, { parentId: phase.id, title, ...extra });
  const todoTask = await task('Todo');
  const queuedTask = await task('Queued');
  await queueTask(store, queuedTask.id, {
    harness: 'orchestrator',
    host: 'run-host',
    session: 'run-1',
  });
  const waitingTask = await task('Waiting');
  await depend(store, waitingTask.id, [todoTask.id]);
  const taggedTask = await task('Tagged', { tags: ['engine'] });
  const startedTask = await task('Started');
  await startTask(store, startedTask.id, { session: 'writes-test' });
  await annotate(store, startedTask.id, 'Evidence');
  const reviewTask = await task('Review');
  await startTask(store, reviewTask.id);
  await submitTask(store, reviewTask.id);
  const doneTask = await task('Done');
  await completeTask(store, doneTask.id);
  const parkedTask = await task('Parked');
  await parkTask(store, parkedTask.id, 'later');
  const blockedTask = await task('Blocked');
  await blockTask(store, blockedTask.id, 'waiting');
  await attachArtifact(store, {
    content: 'Body',
    linkNodeIds: [todoTask.id],
    projectId: 'ENG',
    title: 'Existing',
  });
  await tagEntities(store, [{ entityId: 'ENG', entityType: 'project' }], ['engine']);
  const seed = await fileSeed(store, { kind: 'idea', project: 'ENG', title: 'Untriaged idea' });
  const parked = await fileSeed(store, { kind: 'idea', project: 'ENG', title: 'Parked idea' });
  await parkSeed(store, parked.id);
  const local = new LocalEngine(store);
  const handle = createEngineHandler(local, {
    verifyToken: fixture.tokens.verify,
    version: WINDOW_VERSION,
  });
  const remote = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version: WINDOW_VERSION,
  });
  return {
    close: fixture.close,
    ids: {
      blockedTask: blockedTask.id,
      doneTask: doneTask.id,
      initiative: initiative.id,
      otherPhase: otherPhase.id,
      parkedSeed: parked.id,
      parkedTask: parkedTask.id,
      phase: phase.id,
      queuedTask: queuedTask.id,
      reviewTask: reviewTask.id,
      seed: seed.id,
      startedTask: startedTask.id,
      taggedTask: taggedTask.id,
      todoTask: todoTask.id,
      waitingTask: waitingTask.id,
    },
    local,
    remote,
  };
}

beforeAll(() => setSystemTime(new Date('2026-03-01T12:00:00.000Z')));
afterAll(() => setSystemTime());

type WriteMethod = {
  [K in keyof EngineMethods]: (typeof engineSchemas)[K]['kind'] extends 'mutation' ? K : never;
}[keyof EngineMethods];
type WriteCase = {
  method: WriteMethod;
  label: string;
  input: (ids: Ids) => unknown;
  /** Proves the write took effect, so equality is not two identical no-ops. */
  check: (output: never, ids: Ids, read: Engine) => void | Promise<void>;
};

/** Pairs a method with an input and check; the generics tie both to the method's contract. */
function write<K extends WriteMethod>(
  method: K,
  label: string,
  input: (ids: Ids) => EngineInput<K>,
  check: (output: Awaited<ReturnType<Engine[K]>>, ids: Ids, read: Engine) => void | Promise<void>,
): WriteCase {
  return { check, input, label, method };
}

const writes: WriteCase[] = [
  write(
    'create',
    'a task with every field',
    (ids) => ({
      description: 'Body',
      externalRef: 'EXT-1',
      groomed: true,
      handles: { branch: 'feat/x' },
      parent: ids.phase,
      priority: 'p1',
      size: 'small',
      summary: 'Lede',
      tags: ['new'],
      title: 'Fresh task',
      type: 'task',
      upstream: 'ENG-s1',
    }),
    async (node, _ids, read) => {
      expect(node.type).toBe('task');
      expect(node.priority).toBe('p1');
      expect(node.size).toBe('small');
      expect(node.grooming).toBe('groomed');
      expect(node.branch).toBe('feat/x');
      expect(node.upstream).toBe('ENG-s1');
      expect(node.tags?.map((tag) => tag.tag)).toBeUndefined();
      const full = await read.getNode({ facets: ['tags'], id: node.id });
      expect(full.tags?.map((tag) => tag.tag)).toEqual(['new']);
    },
  ),
  write(
    'update',
    'main and whole-task worker assignment',
    (ids) => ({
      harness: 'codex',
      id: ids.todoTask,
      session: 'main',
      workerHarness: 'claude',
      workerSession: 'worker',
    }),
    async (node, _ids, read) => {
      expect(node.workerHarness).toBe('claude');
      expect(node.workerSession).toBe('worker');
      const history = (await read.getNode({ facets: ['history'], id: node.id })).history;
      expect(history?.at(-1)?.kind).toBe('assignment');
      expect(history?.at(-1)?.handles).toEqual({
        harness: 'codex',
        session: 'main',
        worker_harness: 'claude',
        worker_session: 'worker',
      });
    },
  ),
  write(
    'updateProject',
    'name, direction, and pin',
    () => ({ id: 'ENG', name: 'Engine two', next: 'Direction', pinned: true }),
    (node) => {
      expect(node.title).toBe('Engine two');
      expect(node.pinned).toBe(true);
      expect(node.next).toBe('Direction');
    },
  ),
  write(
    'annotate',
    'a note',
    (ids) => ({ content: 'A fresh note', id: ids.startedTask }),
    async (node, ids, read) => {
      expect(node.id).toBe(ids.startedTask);
      const full = await read.getNode({ facets: ['annotations'], id: node.id });
      expect(full.annotations?.map((note) => note.content)).toEqual(['Evidence', 'A fresh note']);
      expect(full.annotations?.[0]?.createdAt).toBeInstanceOf(Date);
    },
  ),
  write(
    'attach',
    'an artifact linked to a task',
    (ids) => ({
      content: 'Frozen',
      links: [ids.todoTask],
      summary: 'Lede',
      tags: ['session_summary'],
      title: 'Proof',
    }),
    (artifact, ids) => {
      expect(artifact.id).toBe('ENG-a2');
      expect(artifact.content).toBe('Frozen');
      expect(artifact.links).toEqual([ids.todoTask]);
      expect(artifact.createdAt).toBeInstanceOf(Date);
    },
  ),
  write(
    'updateArtifact',
    'a title and a summary',
    () => ({ id: 'ENG-a1', summary: 'A lede', title: 'Renamed proof' }),
    (artifact) => {
      expect(artifact.title).toBe('Renamed proof');
      expect(artifact.summary).toBe('A lede');
      expect(artifact.content).toBeUndefined();
    },
  ),
  write(
    'depend',
    'a prerequisite',
    (ids) => ({ id: ids.todoTask, on: [ids.startedTask] }),
    async (node, ids, read) => {
      const full = await read.getNode({ facets: ['deps'], id: node.id });
      expect(full.deps?.dependsOn.map((dep) => dep.id)).toEqual([ids.startedTask]);
    },
  ),
  write(
    'undepend',
    'a prerequisite',
    (ids) => ({ id: ids.waitingTask, on: [ids.todoTask] }),
    async (node, _ids, read) => {
      const full = await read.getNode({ facets: ['deps'], id: node.id });
      expect(full.deps?.dependsOn).toEqual([]);
      expect(node.status).toBe('ready');
    },
  ),
  write(
    'move',
    'a task under another phase',
    (ids) => ({ id: ids.todoTask, to: ids.otherPhase }),
    (node, ids) => expect(node.parent).toBe(ids.otherPhase),
  ),
  write(
    'reorder',
    'to the top',
    (ids) => ({ id: ids.startedTask, position: 'top' }),
    async (node, ids, read) => {
      const tree = await read.tree({ id: ids.phase });
      expect(tree.children?.[0]?.id).toBe(node.id);
    },
  ),
  write(
    'groom',
    'two tasks with a note',
    (ids) => ({
      ids: [ids.todoTask, ids.taggedTask],
      note: 'Which store?',
      state: 'needs_answers',
    }),
    (nodes, ids) => {
      expect(nodes.map((node) => node.id)).toEqual([ids.todoTask, ids.taggedTask]);
      expect(nodes.every((node) => node.grooming === 'needs_answers')).toBe(true);
    },
  ),
  write(
    'tag',
    'a task and a project',
    (ids) => ({ ids: [ids.todoTask, 'ENG'], tags: ['alpha', 'beta'] }),
    async (result, ids, read) => {
      expect(result).toEqual({ ids: [ids.todoTask, 'ENG'], tags: ['alpha', 'beta'] });
      const task = await read.getNode({ facets: ['tags'], id: ids.todoTask });
      expect(task.tags?.map((tag) => tag.tag).toSorted()).toEqual(['alpha', 'beta']);
      const project = await read.tree({ facets: ['tags'], id: 'ENG' });
      expect(project.tags?.map((tag) => tag.tag)).toEqual(
        expect.arrayContaining(['alpha', 'beta']),
      );
    },
  ),
  write(
    'untag',
    'a task and a project',
    (ids) => ({ ids: [ids.taggedTask, 'ENG'], tags: ['engine'] }),
    (result) => expect(result.removed).toBe(2),
  ),
  write(
    'queue',
    'an autonomous reservation',
    (ids) => ({ harness: 'orchestrator', id: ids.todoTask, session: 'run-2' }),
    (node) => {
      expect(node.status).toBe('queued');
      expect(node.session).toBe('run-2');
    },
  ),
  write(
    'unqueue',
    'a cancelled reservation',
    (ids) => ({ id: ids.queuedTask, reason: 'run cancelled' }),
    (node) => {
      expect(node.status).toBe('ready');
      expect(node.session).toBeNull();
    },
  ),
  write(
    'start',
    'a reserved task with an observed main assignment',
    (ids) => ({
      id: ids.queuedTask,
      startExpectation: { harness: 'orchestrator', lifecycle: 'queued', session: 'run-1' },
      workerSession: 'worker-guarded',
    }),
    (node) => {
      expect(node.lifecycle).toBe('in_progress');
      expect(node.session).toBe('run-1');
      expect(node.workerHarness).toBeNull();
      expect(node.workerSession).toBe('worker-guarded');
    },
  ),
  write(
    'start',
    'a todo task with resume handles',
    (ids) => ({ branch: 'feat/y', id: ids.todoTask, session: 's-1' }),
    async (node, _ids, read) => {
      expect(node.lifecycle).toBe('in_progress');
      expect(node.branch).toBe('feat/y');
      const full = await read.getNode({ facets: ['history'], id: node.id });
      expect(full.history?.[0]?.at).toBeInstanceOf(Date);
    },
  ),
  write(
    'submit',
    'an in-progress task',
    (ids) => ({ id: ids.startedTask }),
    (node) => expect(node.lifecycle).toBe('under_review'),
  ),
  write(
    'stage',
    'a task under review',
    (ids) => ({ id: ids.reviewTask }),
    (node) => expect(node.lifecycle).toBe('staged'),
  ),
  write(
    'return',
    'a task under review',
    (ids) => ({ id: ids.reviewTask, reason: 'needs tests' }),
    (node) => expect(node.lifecycle).toBe('in_progress'),
  ),
  write(
    'done',
    'a task under review',
    (ids) => ({ id: ids.reviewTask }),
    (node) => expect(node.lifecycle).toBe('done'),
  ),
  write(
    'abandon',
    'a todo task with a reason',
    (ids) => ({ id: ids.todoTask, reason: 'obsolete' }),
    (node) => expect(node.lifecycle).toBe('abandoned'),
  ),
  write(
    'reopen',
    'a done task',
    (ids) => ({ id: ids.doneTask, reason: 'regressed' }),
    (node) => expect(node.lifecycle).toBe('in_progress'),
  ),
  write(
    'park',
    'a task',
    (ids) => ({ id: ids.todoTask, reason: 'later' }),
    (node) => expect(node).toHaveProperty('hold', 'parked'),
  ),
  write(
    'park',
    'a seed',
    (ids) => ({ id: ids.seed, reason: 'not now' }),
    (seed) => expect(seed).toHaveProperty('lifecycle', 'parked'),
  ),
  write(
    'unpark',
    'a task',
    (ids) => ({ id: ids.parkedTask }),
    (node) => expect(node).toHaveProperty('hold', 'none'),
  ),
  write(
    'unpark',
    'a seed',
    (ids) => ({ id: ids.parkedSeed }),
    (seed) => expect(seed).toHaveProperty('lifecycle', 'new'),
  ),
  write(
    'block',
    'a task on others',
    (ids) => ({ id: ids.todoTask, on: 'others', reason: 'vendor' }),
    (node) => {
      expect(node.hold).toBe('blocked');
      expect(node.blockOwner).toBe('others');
    },
  ),
  write(
    'unblock',
    'a blocked task',
    (ids) => ({ id: ids.blockedTask }),
    (node) => expect(node.hold).toBe('none'),
  ),
  write(
    'archive',
    'a project',
    () => ({ id: 'OTH', reason: 'done with it' }),
    (node) => {
      expect(node.id).toBe('OTH');
      expect(node.archivedAt).toBeInstanceOf(Date);
      expect(node.released).toEqual([]);
    },
  ),
  write(
    'unarchive',
    'a project',
    () => ({ id: 'ARC' }),
    (node) => expect(node.archivedAt ?? null).toBeNull(),
  ),
];

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

/** Calls a write by name; the case table already ties each input to its method. */
function call(engine: Engine, method: WriteMethod, input: unknown) {
  return (Reflect.get(engine, method) as (input: unknown) => Promise<unknown>).call(engine, input);
}

/** Seed and Scratchpad writes (MMR-518) are proved in seed-scratch-writes.test.ts. */
const SEED_SCRATCH_WRITE = /^(?:seed|scratch)[A-Z]|^triage$/;

test('the write table names every node-write mutation method in the contract', () => {
  const mutations = Object.entries(engineSchemas)
    .filter(([name, schema]) => schema.kind === 'mutation' && !SEED_SCRATCH_WRITE.test(name))
    .map(([name]) => name);
  expect([...new Set(writes.map((entry): string => entry.method))].toSorted()).toEqual(
    mutations.toSorted(),
  );
});

test('the Engine carries every uniform verb, with the arguments its fact declares', () => {
  for (const verb of UNIFORM_VERBS) {
    const fact = OP_FACTS[verb];
    const schema = engineSchemas[verb];
    expect(schema.kind).toBe('mutation');
    const keys = Object.keys(schema.input.shape).toSorted();
    const expected = [
      'id',
      ...(fact.reason !== 'none' ? ['reason'] : []),
      ...('fields' in fact ? fact.fields.map((field) => HANDLE_FIELD_ARGS[field]) : []),
      ...('choice' in fact ? [fact.choice.name] : []),
      ...(verb === 'start' ? ['startExpectation'] : []),
    ].toSorted();
    expect(keys).toEqual(expected);
  }
});

describe.each(writes)('$method ($label)', (entry) => {
  test('returns the same values, with Date instants, locally and remotely', async () => {
    const [a, b] = [await buildFixture(), await buildFixture()];
    try {
      const expected = await call(a.local, entry.method, entry.input(a.ids));
      const actual = await call(b.remote, entry.method, entry.input(b.ids));
      expect(actual).toStrictEqual(expected);
      expect(isoStrings(actual)).toEqual([]);
      await entry.check(actual as never, b.ids, b.remote);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

type Refusal = {
  method: WriteMethod;
  label: string;
  code: 'not_found' | 'validation';
  input: (ids: Ids) => unknown;
};

// The first two rows carry a validation and a not_found refusal through the explicit
// procedures; engine.test.ts proves the mapping for validation, not_found, and conflict.
// No wire test reads an invariant refusal. The rest pin the
// guards in core's Engine adapter (engine-node-writes.ts), which core's mutation tests do not
// reach. Core owns every other refusal rule.
const refusals: Refusal[] = [
  {
    code: 'validation',
    input: (ids: Ids) => ({ parent: ids.phase, title: '   ', type: 'task' }),
    label: 'a blank task title',
    method: 'create',
  },
  {
    code: 'not_found',
    input: () => ({ id: 'ENG-99', title: 'x' }),
    label: 'an unknown node',
    method: 'update',
  },
  {
    code: 'validation',
    input: (ids: Ids) => ({ parent: ids.phase, title: 'U', type: 'task', upstream: 'none' }),
    label: 'the none upstream sentinel',
    method: 'create',
  },
  {
    code: 'validation',
    input: (ids: Ids) => ({ id: ids.todoTask, upstream: 'garbage' }),
    label: 'a malformed upstream',
    method: 'update',
  },
  {
    code: 'validation',
    input: () => ({ id: 'ENG', title: 'x' }),
    label: 'a project key',
    method: 'update',
  },
  {
    code: 'validation',
    input: () => ({ id: 'ENG' }),
    label: 'a project key on a task verb',
    method: 'done',
  },
  {
    code: 'validation',
    input: () => ({ content: 'x', title: 'No home' }),
    label: 'neither a project nor a link',
    method: 'attach',
  },
];

describe.each(refusals)('$method refuses $label', (entry) => {
  test('with the same code, message, and hint locally and remotely', async () => {
    const [a, b] = [await buildFixture(), await buildFixture()];
    try {
      const localError = await errorOf(call(a.local, entry.method, entry.input(a.ids)));
      const remoteError = await errorOf(call(b.remote, entry.method, entry.input(b.ids)));
      expect(localError.code).toBe(entry.code);
      expect(remoteError.code).toBe(localError.code);
      expect(remoteError.message).toBe(localError.message);
      expect(remoteError.hint).toBe(localError.hint);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
