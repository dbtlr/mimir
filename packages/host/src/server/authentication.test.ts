import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RemoteEngine } from '@mimir/wire/client';

import { readHostConfig } from './config';
import { openHost } from './host';

let root: string;
let host: Awaited<ReturnType<typeof openHost>>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mimir-auth-'));
  host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0', () => undefined);
});
afterEach(async () => {
  await host.close();
  await rm(root, { force: true, recursive: true });
});

function remote(authorization?: string, version = '0.26.0') {
  return new RemoteEngine({
    fetch: async (input, init) => {
      const response = await host.handleTrpc(new Request(input, init));
      return { json: () => response.json(), ok: response.ok };
    },
    headers: authorization === undefined ? {} : { authorization },
    url: 'http://host.test/trpc',
    version,
  });
}

async function redeem(code: string) {
  return host.handleRedeem(
    new Request('http://host.test/auth/pairing/redeem', {
      body: JSON.stringify({ code }),
      method: 'POST',
    }),
  );
}

async function pair(device: string) {
  const response = await redeem(await host.tokens.issueCode(device));
  expect(response.status).toBe(200);
  const credential: unknown = await response.json();
  if (
    !(
      typeof credential === 'object' &&
      credential !== null &&
      'token' in credential &&
      typeof credential.token === 'string'
    )
  ) {
    throw new Error('expected a device token');
  }
  return credential.token;
}

test.each([
  undefined,
  '',
  'Basic unknown',
  'Bearer',
  'Bearer unknown',
  'Bearer one two',
  'Bearer first, Bearer second',
])(
  'missing, malformed, and unknown credentials (%s) receive the same unauthorized refusal',
  async (authorization) => {
    const failure: unknown = await remote(authorization)
      .projects({})
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      data: { code: 'UNAUTHORIZED', httpStatus: 401, mimirError: null },
      message: 'unauthorized',
    });
  },
);

test('pairing again rotates a device token and revocation takes effect on the next RemoteEngine call', async () => {
  const first = remote(`Bearer ${await pair('laptop')}`);
  await first.create({ key: 'AUTH', name: 'Paired device', type: 'project' });
  const token = await pair('laptop');
  const second = remote(`bearer ${token}`);
  expect(await second.projects({})).toMatchObject([{ id: 'AUTH' }]);
  expect(await first.projects({}).catch((error: unknown) => error)).toMatchObject({
    data: { httpStatus: 401 },
    message: 'unauthorized',
  });
  await host.tokens.revoke('laptop');
  expect(await second.projects({}).catch((error: unknown) => error)).toMatchObject({
    data: { httpStatus: 401 },
    message: 'unauthorized',
  });
  // The console's store-owning Engine is independent of transport credentials.
  expect(await host.engine.console.openTasks({ q: '' })).toBeDefined();
});

test('tokenless writes and console procedures are refused before Engine work or input parsing', async () => {
  const client = remote();
  expect(
    await client
      .create({ key: 'NO', name: 'Refused', type: 'project' })
      .catch((error: unknown) => error),
  ).toMatchObject({ message: 'unauthorized' });
  expect(await host.engine.projects({})).toEqual([]);
  expect(
    await client.console.overview({ project: '' }).catch((error: unknown) => error),
  ).toMatchObject({ message: 'unauthorized' });
  expect(
    await remote(undefined, '0.25.0')
      .projects({})
      .catch((error: unknown) => error),
  ).toMatchObject({ code: 'validation', hint: 'update this CLI' });
});

test.each(['projects,removed', 'projects%2Cremoved'])(
  'a tokenless batch (%s) refuses every procedure with unauthorized',
  async (path) => {
    const response = await host.handleTrpc(
      new Request(`http://host.test/trpc/${path}?batch=1`, {
        headers: { 'x-mimir-version': '0.26.0' },
      }),
    );
    expect(response.status).toBe(401);
    const failure = {
      error: { json: { data: { code: 'UNAUTHORIZED', httpStatus: 401 }, message: 'unauthorized' } },
    };
    expect(await response.json()).toMatchObject([failure, failure]);
  },
);

test('expired, used, and unknown codes have identical HTTP failures', async () => {
  const expired = await host.tokens.issueCode('expired');
  const database = new Database(join(root, 'store.sqlite'));
  try {
    // Simulate a pending code whose ten-minute lifetime has passed.
    database.run("UPDATE pairing_codes SET expires_at = '2000-01-01T00:00:00.000Z'");
  } finally {
    database.close();
  }
  const used = await host.tokens.issueCode('used');
  expect((await redeem(used)).status).toBe(200);
  for (const code of [expired, used, 'UNKNOWN1']) {
    const response = await redeem(code);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid pairing code' });
  }
});
