import { afterEach, beforeEach, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import { LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

let fixture: TestStore;
let authorization: string;
let local: LocalEngine;
beforeEach(async () => {
  fixture = await createTestStore();
  authorization = `Bearer ${await pairTestDevice(fixture.tokens, 'wire-fixture')}`;
  local = new LocalEngine(fixture.store);
});
afterEach(async () => fixture.close());

function client(version: string, stripVersion = false, hostVersion = '0.26.0-next.10') {
  const handle = createEngineHandler(local, {
    verifyToken: fixture.tokens.verify,
    version: hostVersion,
  });
  return new RemoteEngine({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (stripVersion) {
        request.headers.delete('x-mimir-version');
      }
      const response = await handle(request);
      return { json: () => response.json(), ok: response.ok };
    },
    headers: { authorization },
    url: 'http://engine.test/trpc',
    version,
  });
}

test('an older client receives the update-this-CLI remedy as a MimirError', async () => {
  const failure: unknown = await client('0.25.99')
    .projects({})
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MimirError);
  expect(failure).toMatchObject({
    code: 'validation',
    hint: 'update this CLI',
  });
  if (!(failure instanceof MimirError)) {
    throw new Error('expected MimirError');
  }
  expect(failure.message).toContain('0.25.99');
  expect(failure.message).toContain('0.26.0-next');
});

test('a newer minor client receives the update-host-first remedy', async () => {
  const failure: unknown = await client('0.27.0-next.1')
    .projects({})
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MimirError);
  expect(failure).toMatchObject({ code: 'validation', hint: 'update the host first' });
  if (!(failure instanceof MimirError)) {
    throw new Error('expected MimirError');
  }
  expect(failure.message).toContain('0.27.0-next.1');
  expect(failure.message).toContain('0.26.0-next.10');
});

test('a missing header is refused with the CLI update remedy', async () => {
  const failure: unknown = await client('0.26.0', true)
    .projects({})
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MimirError);
  expect(failure).toMatchObject({ code: 'validation', hint: 'update this CLI' });
});

test.each(['garbage', '0.26', '0.26.0-next.01', '0.26.0, 0.25.0'])(
  'malformed version %s is a domain refusal',
  async (version) => {
    const failure: unknown = await client(version)
      .projects({})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MimirError);
    expect(failure).toMatchObject({ code: 'validation', hint: 'update this CLI' });
  },
);

test.each([
  '0.26.0-next',
  '0.26.0-next.2',
  '0.26.0-next.11',
  '0.26.0',
  '0.26.99',
  'v0.26.1+build.2',
])('in-window client %s can read and mutate', async (version) => {
  const remote = client(version);
  expect(await remote.projects({})).toEqual([]);
  await remote.create({ key: 'WIN', name: 'In window', type: 'project' });
  expect(await remote.getNode({ id: 'WIN' })).toMatchObject({ title: 'In window' });
});

test('newer major clients are refused even when their minor is lower', async () => {
  const failure: unknown = await client('1.0.0')
    .projects({})
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'validation', hint: 'update the host first' });
});

test('refused mutation and console requests stop before input parsing or Engine work', async () => {
  const remote = client('0.27.0');
  const mutation: unknown = await remote
    .create({ key: 'NO', name: 'Refused', type: 'project' })
    .catch((error: unknown) => error);
  expect(mutation).toMatchObject({ code: 'validation', hint: 'update the host first' });
  expect(await local.projects({})).toEqual([]);
  const consoleRead: unknown = await remote.console
    .overview({ project: '' })
    .catch((error: unknown) => error);
  expect(consoleRead).toBeInstanceOf(MimirError);
  expect(consoleRead).toMatchObject({ code: 'validation', hint: 'update the host first' });
});

test('the async headers hook runs on every call alongside the build version', async () => {
  const handle = createEngineHandler(local, {
    verifyToken: fixture.tokens.verify,
    version: '0.26.0',
  });
  let calls = 0;
  const seen: { device: string | null; version: string | null }[] = [];
  const remote = new RemoteEngine({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        device: request.headers.get('x-device'),
        version: request.headers.get('x-mimir-version'),
      });
      const response = await handle(request);
      return { json: () => response.json(), ok: response.ok };
    },
    headers: async () => ({
      'X-Mimir-Version': '0.25.0',
      authorization,
      'x-device': String(++calls),
    }),
    url: 'http://engine.test/trpc',
    version: '0.26.0',
  });
  await remote.projects({});
  await remote.console.openTasks({ q: '' });
  expect(seen).toEqual([
    { device: '1', version: '0.26.0' },
    { device: '2', version: '0.26.0' },
  ]);
});

test('the window admits an older minor still above the minimum client', async () => {
  expect(await client('0.27.1', false, '0.28.0').projects({})).toEqual([]);
});

test('an invalid host version cannot silently disable the upper bound', () => {
  expect(() =>
    createEngineHandler(local, { verifyToken: fixture.tokens.verify, version: 'unknown' }),
  ).toThrow('invalid host version');
});

test.each(['removed procedure', 'changed procedure kind'])(
  'an old client still gets the update remedy for a %s',
  async (scenario) => {
    const handle = createEngineHandler(local, {
      verifyToken: fixture.tokens.verify,
      version: '0.26.0',
    });
    const remote = new RemoteEngine({
      fetch: async (input, init) => {
        const request =
          scenario === 'removed procedure'
            ? new Request(String(input).replace('/projects', '/projectsLegacy'), init)
            : new Request(input, { ...init, body: JSON.stringify({ json: {} }), method: 'POST' });
        const response = await handle(request);
        return { json: () => response.json(), ok: response.ok };
      },
      headers: { authorization },
      url: 'http://engine.test/trpc',
      version: '0.25.0',
    });
    const error: unknown = await remote.projects({}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MimirError);
    expect(error).toMatchObject({ code: 'validation', hint: 'update this CLI' });
  },
);

test.each(['projects,projectsLegacy', 'projects%2CprojectsLegacy'])(
  'an out-of-window HTTP batch %s carries a version refusal per requested procedure',
  async (path) => {
    const handle = createEngineHandler(local, {
      verifyToken: fixture.tokens.verify,
      version: '0.26.0',
    });
    const response = await handle(
      new Request(`http://engine.test/trpc/${path}?batch=1`, {
        headers: { 'x-mimir-version': '0.25.0' },
      }),
    );
    expect(response.status).toBe(400);
    const refusal = {
      error: { json: { data: { mimirError: { code: 'validation', hint: 'update this CLI' } } } },
    };
    expect(await response.json()).toMatchObject([refusal, refusal]);
  },
);
