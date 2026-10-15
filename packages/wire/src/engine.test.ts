import { afterEach, beforeEach, expect, test } from 'bun:test';

import { engineSchemas } from '@mimir/contract';
import {
  annotate,
  archiveProject,
  attachArtifact,
  createInitiative,
  createProject,
  createTask,
  LocalEngine,
  startTask,
  MimirError,
} from '@mimir/core';
import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler, createEngineRouter } from './server';

let fixture: TestStore;
let local: LocalEngine;
let remote: RemoteEngine;
let id: string;

beforeEach(async () => {
  fixture = await createTestStore();
  await createProject(fixture.store, { key: 'ENG', name: 'Engine' });
  const parent = await createInitiative(fixture.store, { projectId: 'ENG', title: 'Engine' });
  const task = await createTask(fixture.store, {
    parentId: parent.id,
    tags: ['engine'],
    title: 'Over the wire',
  });
  id = task.id;
  local = new LocalEngine(fixture.store);
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

test('getNode crosses a real fetch handler with the same values and Date instances', async () => {
  const expected = await local.getNode({ id });
  const actual = await remote.getNode({ id });
  expect(actual).toEqual(expected);
  expect(actual.createdAt).toBeInstanceOf(Date);
  expect(actual.updatedAt).toBeInstanceOf(Date);
});

test('either Engine can complete work that the other reads back unchanged', async () => {
  const done = await remote.done({ id });
  expect(done.lifecycle).toBe('done');
  expect(done.completedAt).toBeInstanceOf(Date);
  expect(
    await local.getNode({ facets: ['description', 'next', 'children', 'distribution'], id }),
  ).toEqual(done);
  expect(await remote.getNode({ id })).toEqual(await local.getNode({ id }));
});

test('missing records and illegal transitions preserve MimirError code, message, and hint', async () => {
  const missing = { id: 'NOPE' };
  const localError = await errorOf(local.getNode(missing));
  const remoteError = await errorOf(remote.getNode(missing));
  expect(remoteError.code).toBe('not_found');
  expect(remoteError.message).toBe(localError.message);
  expect(remoteError.hint).toBe(localError.hint);
  await local.done({ id });
  const refusedLocal = await errorOf(local.done({ id }));
  const refusedRemote = await errorOf(remote.done({ id }));
  expect(refusedRemote.code).toBe('validation');
  expect(refusedRemote.message).toBe(refusedLocal.message);
  expect(refusedRemote.hint).toBe(refusedLocal.hint);
});

test('nested timestamps, facets, and resume handles survive serialization', async () => {
  await annotate(fixture.store, id, 'Evidence');
  await startTask(fixture.store, id, { session: 'engine-test' });
  await attachArtifact(fixture.store, {
    content: 'Frozen evidence',
    linkNodeIds: [id],
    projectId: 'ENG',
    title: 'Proof',
  });
  const input = {
    facets: ['annotations', 'tags', 'artifacts', 'history', 'home', 'verdicts'] as const,
    id,
  };
  const request = { ...input, facets: [...input.facets] };
  const actual = await remote.getNode(request);
  expect(actual).toEqual(await local.getNode(request));
  expect(actual.annotations?.[0]?.createdAt).toBeInstanceOf(Date);
  expect(actual.tags?.[0]?.createdAt).toBeInstanceOf(Date);
  expect(actual.artifacts?.[0]?.createdAt).toBeInstanceOf(Date);
  expect(actual.history?.[0]?.at).toBeInstanceOf(Date);
  expect(actual.history?.[0]?.handles?.session).toBe('engine-test');
  const done = await local.done({ id });
  expect(done.session).toBeNull();
  expect(
    await remote.getNode({ facets: ['description', 'next', 'children', 'distribution'], id }),
  ).toEqual(done);
  expect(await remote.getNode({ id: 'ENG' })).toEqual(await local.getNode({ id: 'ENG' }));
});

test('malformed input has the same validation refusal on both Engines', async () => {
  const input = { id: 42 } as unknown as Parameters<LocalEngine['done']>[0];
  const localError = await errorOf(local.done(input));
  const remoteError = await errorOf(remote.done(input));
  expect(remoteError.code).toBe('validation');
  expect(remoteError.message).toBe(localError.message);
});

test('an archived project retains its conflict code and recovery hint', async () => {
  await archiveProject(fixture.store, 'ENG');
  const expected = await errorOf(local.done({ id }));
  const actual = await errorOf(remote.done({ id }));
  expect(actual.code).toBe('conflict');
  expect(actual.message).toBe(expected.message);
  expect(actual.hint).toBe(expected.hint);
  expect(actual.hint).toContain('unarchive');
});

test('explicit undefined is preserved and non-domain failures stay transport errors', async () => {
  const read = local.getNode.bind(local);
  const getNode = async (input: Parameters<LocalEngine['getNode']>[0]) => ({
    ...(await read(input)),
    next: undefined,
  });
  const handle = createEngineHandler({
    done: async () => {
      throw new Error('host failure');
    },
    getNode,
  });
  const client = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    url: 'http://engine.test/trpc',
  });
  const actual = await client.getNode({ id });
  expect(Object.hasOwn(actual, 'next')).toBe(true);
  expect(actual).toEqual(await getNode({ id }));
  try {
    await client.done({ id });
    throw new Error('expected a transport failure');
  } catch (error) {
    expect(error).not.toBeInstanceOf(MimirError);
    expect(error).toHaveProperty('name', 'TRPCClientError');
  }
});

function assertBindings(bindings: Record<string, object>) {
  for (const [layer, binding] of Object.entries(bindings)) {
    for (const method of Object.keys(engineSchemas)) {
      if (typeof Reflect.get(binding, method) !== 'function') {
        throw new Error(`${layer} is missing Engine.${method}`);
      }
    }
  }
}

test('every Engine method has a local implementation, router procedure, and remote binding', () => {
  assertBindings({ local, remote, router: createEngineRouter(local)._def.procedures });
});

test.each(['local', 'router', 'remote'])('parity rejects a missing %s binding', (layer) => {
  const bindings = {
    local,
    remote,
    router: createEngineRouter(local)._def.procedures,
  };
  const broken = Object.create(bindings[layer]);
  Object.defineProperty(broken, 'done', { value: undefined });
  expect(() => assertBindings({ ...bindings, [layer]: broken })).toThrow(
    `${layer} is missing Engine.done`,
  );
});
