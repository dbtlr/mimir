import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

import { consoleSchemas, engineSchemas } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
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
import { createTestStore, errorOf, pairTestDevice } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler, createEngineRouter } from './server';

let fixture: TestStore;
let authorization: string;
let local: LocalEngine;
let remote: RemoteEngine;
let id: string;

beforeEach(async () => {
  fixture = await createTestStore();
  authorization = `Bearer ${await pairTestDevice(fixture.tokens, 'wire-fixture')}`;
  await createProject(fixture.store, { key: 'ENG', name: 'Engine' });
  const parent = await createInitiative(fixture.store, { projectId: 'ENG', title: 'Engine' });
  const task = await createTask(fixture.store, {
    parentId: parent.id,
    tags: ['engine'],
    title: 'Over the wire',
  });
  id = task.id;
  local = new LocalEngine(fixture.store);
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

test('explicit undefined survives serialization as an own property', async () => {
  const read = local.getNode.bind(local);
  const getNode = async (input: Parameters<LocalEngine['getNode']>[0]) => ({
    ...(await read(input)),
    next: undefined,
  });
  const handle = createEngineHandler(withOverride(local, { getNode }), {
    verifyToken: fixture.tokens.verify,
    version: '0.26.0',
  });
  const client = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version: '0.26.0',
  });
  const actual = await client.getNode({ id });
  expect(Object.hasOwn(actual, 'next')).toBe(true);
  expect(actual).toEqual(await getNode({ id }));
});

test('unexpected wire faults log their details without sending library text or stacks', async () => {
  const fault = new Error('driver private detail\nforged log\u2028next line');
  const log = spyOn(console, 'error').mockReturnValue(undefined);
  const handle = createEngineHandler(
    withOverride(local, {
      done: async () => {
        throw fault;
      },
    }),
    { verifyToken: fixture.tokens.verify, version: '0.26.0' },
  );
  const client = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version: '0.26.0',
  });
  try {
    const failure: unknown = await client.done({ id }).catch((error: unknown) => error);
    expect(failure).toHaveProperty('name', 'TRPCClientError');
    expect(failure).not.toBeInstanceOf(MimirError);
    expect(failure).toHaveProperty('message', 'the request did not complete');
    expect(failure).toHaveProperty('data.hint', "run 'mimir doctor'");
    expect(failure).toHaveProperty('data.code', 'INTERNAL_SERVER_ERROR');
    expect(failure).toHaveProperty('data.mimirError', null);
    expect(failure).not.toHaveProperty('data.stack');
    expect(log).toHaveBeenCalledTimes(1);
    const line: unknown = log.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    if (typeof line !== 'string') {
      throw new Error('missing fault diagnostic');
    }
    expect(line).toContain('driver private detail');
    expect(line).toContain('"method":"POST"');
    expect(line).toContain('"path":"/trpc/done"');
    expect(line).not.toMatch(/[\n\r\u2028\u2029]/);
    const beforeRefusal = log.mock.calls.length;
    await errorOf(client.getNode({ id: 'NOPE' }));
    expect(log).toHaveBeenCalledTimes(beforeRefusal);
  } finally {
    log.mockRestore();
  }
});

test('a credential store fault fails closed with the generic wire refusal', async () => {
  const log = spyOn(console, 'error').mockReturnValue(undefined);
  const handle = createEngineHandler(local, {
    verifyToken: () => Promise.reject(new Error('credential database private detail')),
    version: '0.26.0',
  });
  try {
    const response = await handle(
      new Request('http://engine.test/trpc/projects', {
        headers: { authorization, 'x-mimir-version': '0.26.0' },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('the request did not complete');
    expect(body).not.toContain('credential database private detail');
    expect(body).not.toContain('stack');
    expect(log).toHaveBeenCalledTimes(1);
    expect(await local.projects({})).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

/** The full Engine with one method replaced, for wire-behavior probes. */
function withOverride(engine: Engine, override: Partial<Engine>): Engine {
  return Object.assign(Object.create(engine) as Engine, override);
}

test('an output-schema fault logs the failing fields its stack omits, never sending them', async () => {
  const log = spyOn(console, 'error').mockReturnValue(undefined);
  const getNode = async (input: Parameters<LocalEngine['getNode']>[0]) => ({
    ...(await local.getNode(input)),
    createdAt: 'not a date',
  });
  // The output schema is the contract under test, so the override breaks it on purpose.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const broken = { getNode } as unknown as Partial<Engine>;
  const handle = createEngineHandler(withOverride(local, broken), {
    verifyToken: fixture.tokens.verify,
    version: '0.26.0',
  });
  const client = new RemoteEngine({
    fetch: async (input, init) => {
      const response = await handle(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version: '0.26.0',
  });
  try {
    const failure: unknown = await client.getNode({ id }).catch((error: unknown) => error);
    expect(failure).toHaveProperty('message', 'the request did not complete');
    expect(failure).not.toHaveProperty('data.stack');
    expect(JSON.stringify(failure)).not.toContain('createdAt');
    expect(log).toHaveBeenCalledTimes(1);
    const line: unknown = log.mock.calls[0]?.[0];
    if (typeof line !== 'string') {
      throw new Error('missing fault diagnostic');
    }
    expect(line).not.toMatch(/[\n\r\u2028\u2029]/);
    const record: unknown = JSON.parse(line.slice(line.indexOf('{')));
    expect(record).toMatchObject({ method: 'GET', path: '/trpc/getNode' });
    expect(record).toHaveProperty('message', expect.stringContaining('createdAt'));
    expect(record).toHaveProperty('stack', expect.stringMatching(/^ZodError/));
  } finally {
    log.mockRestore();
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

/** The `console.*` namespace has its own bindings: a nested object locally and remotely, dotted procedures on the router. */
function assertConsoleBindings(bindings: Record<string, object>) {
  for (const [layer, binding] of Object.entries(bindings)) {
    for (const method of Object.keys(consoleSchemas)) {
      const found =
        layer === 'router'
          ? Reflect.get(binding, `console.${method}`)
          : Reflect.get(Reflect.get(binding, 'console') as object, method);
      if (typeof found !== 'function') {
        throw new Error(`${layer} is missing Engine.console.${method}`);
      }
    }
  }
}

test('every console method has a local implementation, router procedure, and remote binding', () => {
  assertConsoleBindings({ local, remote, router: createEngineRouter(local)._def.procedures });
});

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
