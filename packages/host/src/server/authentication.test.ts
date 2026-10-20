import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RemoteEngine } from '@mimir/wire/client';
import { z } from 'zod';

import { readHostConfig } from './config';
import { openHost } from './host';

let root: string;
let host: Awaited<ReturnType<typeof openHost>>;
let lines: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mimir-auth-'));
  lines = [];
  host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0', (line) =>
    lines.push(line),
  );
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

function post(path: string, body: unknown) {
  return new Request(`http://host.test/auth/pairing/${path}`, {
    body: JSON.stringify(body),
    method: 'POST',
  });
}

async function poll(secret: string) {
  return host.handlePairingPoll(post('poll', { poll_secret: secret }));
}

// File a request over HTTP and approve its code on the host, as an operator would.
async function approvedRequest(device: string) {
  const response = await host.handlePairingRequest(post('requests', { device }));
  expect(response.status).toBe(200);
  const request = z
    .object({ poll_secret: z.string(), user_code: z.string() })
    .parse(await response.json());
  expect(await host.tokens.approve(request.user_code)).toMatchObject({ device });
  return request;
}

async function pair(device: string) {
  const response = await poll((await approvedRequest(device)).poll_secret);
  expect(response.status).toBe(200);
  return z.object({ status: z.literal('approved'), token: z.string() }).parse(await response.json())
    .token;
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

test('expired, consumed, and unknown poll secrets have identical answers', async () => {
  const expired = await approvedRequest('expired');
  const database = new Database(join(root, 'store.sqlite'));
  try {
    // Simulate an approved request whose ten-minute lifetime has passed.
    database.run("UPDATE pairing_requests SET expires_at = '2000-01-01T00:00:00.000Z'");
  } finally {
    database.close();
  }
  const consumed = await approvedRequest('consumed');
  expect((await poll(consumed.poll_secret)).status).toBe(200);
  for (const secret of [expired.poll_secret, consumed.poll_secret, 'unknown']) {
    const response = await poll(secret);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'expired' });
  }
  expect((await host.tokens.list()).map((token) => token.device)).toEqual(['consumed']);
});

test('poll store faults return a safe 500 and the same approval mints after recovery', async () => {
  const request = await approvedRequest('recovering-device');
  lines.length = 0;
  const database = new Database(join(root, 'store.sqlite'));
  database.run('ALTER TABLE device_tokens RENAME TO unavailable_device_tokens');
  try {
    for (let i = 0; i < 5; i++) {
      const response = await poll(request.poll_secret);
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'the request did not complete' });
    }
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(JSON.parse(line)).toEqual({ event: 'pairing_poll_fault', time: expect.any(String) });
      expect(line).not.toContain(request.poll_secret);
      expect(line).not.toContain('device_tokens');
    }
  } finally {
    database.run('ALTER TABLE unavailable_device_tokens RENAME TO device_tokens');
    database.close();
  }
  // A failed mint rolls back, so the approved request still collects its token.
  const recovered = await poll(request.poll_secret);
  expect(await recovered.json()).toMatchObject({ device: 'recovering-device', status: 'approved' });
});
