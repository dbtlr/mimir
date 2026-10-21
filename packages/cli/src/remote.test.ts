/**
 * Remote mode (ADR 0038, MMR-578): with `[host] url` in the config, the CLI
 * reaches work state through RemoteEngine and never opens a store. Each case
 * runs the real composition against an in-process host: the wire handler over
 * a test store, with its version window and bearer check.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInitiative,
  createProject,
  createTask,
  LocalEngine,
  writeCredentials,
} from '@mimir/core';
import type { GlobalConfig } from '@mimir/core';
import { createTestStore, pairTestDevice } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { createEngineHandler } from '@mimir/wire/server';

import { createApp, remoteSource, workStateSource } from './app';
import type { HostSend } from './app';
import { boundClone } from './testing/fixture';
import { runArgv } from './testing/run';
import { VERSION } from './version';

const ORIGIN = 'http://mimir.example.test:64647';

let fixture: TestStore;
let dir: string;
let credentialsFile: string;
let token: string;
let taskId: string;
/** Every request the host received. */
let requests: Request[];
/** The host's own version, which its window is computed from. */
let hostVersion: string;

beforeEach(async () => {
  fixture = await createTestStore();
  token = await pairTestDevice(fixture.tokens, 'valhalla');
  await createProject(fixture.store, { key: 'MMR', name: 'Mimir' });
  const parent = await createInitiative(fixture.store, { projectId: 'MMR', title: 'Remote' });
  taskId = (await createTask(fixture.store, { parentId: parent.id, title: 'Over the wire' })).id;
  dir = mkdtempSync(join(tmpdir(), 'mimir-remote-'));
  credentialsFile = join(dir, 'credentials.toml');
  writeCredentials(
    { device: 'valhalla', issuedAt: '2026-10-20T12:00:00.000Z', origin: ORIGIN, token },
    credentialsFile,
  );
  requests = [];
  hostVersion = VERSION;
});

afterEach(async () => {
  await fixture.close();
  rmSync(dir, { force: true, recursive: true });
});

/** The host's fetch: the wire handler over the test store, recording each request. */
function hostFetch(request: Request): Promise<Response> {
  // Only the request line and headers are read back, so the handler may consume the body.
  requests.push(request);
  return createEngineHandler(new LocalEngine(fixture.store), {
    verifyToken: fixture.tokens.verify,
    version: hostVersion,
  })(request);
}

/** A local-store edge remote mode must never reach. */
const opensStore = (): never => {
  throw new Error('remote mode opened a local store');
};

/** The CLI in remote mode over `config`, bound to MMR, with every local-store edge refusing. */
function remoteApp(
  config: GlobalConfig = { host: { url: `${ORIGIN}/` }, store: {} },
  fetch: HostSend = hostFetch,
) {
  return createApp({
    git: boundClone('MMR'),
    machine: {
      cwd: dir,
      doctor: opensStore,
      openPostgres: opensStore,
      openSqlite: opensStore,
      readConfig: () => config,
      readStdin: () => Promise.resolve(''),
    },
    remote: remoteSource({ config, configFile: join(dir, 'config.toml'), credentialsFile, fetch }),
  });
}

test('reads cross the wire with the bearer token and this CLI version', async () => {
  const projects = await runArgv(remoteApp(), ['projects', '-f', 'ids']);
  expect(projects).toMatchObject({ exitCode: 0, stdout: 'MMR\n' });
  const list = await runArgv(remoteApp(), ['list', '-f', 'ids']);
  expect(list.stdout).toContain(taskId);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(ORIGIN);
    expect(new URL(request.url).pathname).toStartWith('/trpc/');
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(request.headers.get('x-mimir-version')).toBe(VERSION);
  }
});

test('writes land in the host store', async () => {
  const run = await runArgv(remoteApp(), [
    'start',
    taskId,
    '--harness',
    'claude-code',
    '--session',
    'remote-1',
  ]);
  expect(run.exitCode).toBe(0);
  const node = await new LocalEngine(fixture.store).getNode({ id: taskId });
  expect(node.status).toBe('in_progress');
});

test('an Engine refusal reads the same remotely as locally', async () => {
  const local = createApp({ git: boundClone('MMR'), store: () => Promise.resolve(fixture.store) });
  const expected = await runArgv(local, ['get', 'MMR-999']);
  expect(expected.exitCode).toBe(1);
  expect(await runArgv(remoteApp(), ['get', 'MMR-999'])).toEqual(expected);
});

test('a host outside the version window refuses with its remedy', async () => {
  hostVersion = '0.1.0';
  const run = await runArgv(remoteApp(), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('update the host first');
});

test('a token the host does not accept is refused with the pair remedy', async () => {
  await fixture.tokens.revoke('valhalla');
  const run = await runArgv(remoteApp(), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`the host at ${ORIGIN} refused this device's token`);
  expect(run.stderr).toContain(`mimir pair ${ORIGIN}`);
  expect(run.stderr).not.toContain(token);
});

/** A host that cannot be reached: the connection itself fails. */
const down = () =>
  Promise.reject(new TypeError('Unable to connect. Is the computer able to access the url?'));

test('an unreachable host is named by its origin', async () => {
  const run = await runArgv(remoteApp(undefined, down), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`cannot reach the host at ${ORIGIN}`);
  expect(run.stderr).toContain('check that the host is running and that this machine can reach it');
  expect(run.stderr).not.toContain('UNHANDLED');
});

// The token is bound to the origin that issued it, so it never follows a
// redirect to another address.
test('a redirect is refused, not followed', async () => {
  const redirecting = (request: Request) => {
    requests.push(request);
    return Promise.resolve(
      new Response(null, {
        headers: { location: 'https://elsewhere.example.test/trpc' },
        status: 308,
      }),
    );
  };
  const run = await runArgv(remoteApp(undefined, redirecting), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(
    `the host at ${ORIGIN} redirected to https://elsewhere.example.test`,
  );
  expect(run.stderr).toContain('mimir pair https://elsewhere.example.test');
  expect(run.stderr).not.toContain('UNHANDLED');
  expect(requests.map((request) => request.redirect)).toEqual(['manual']);
});

/** A server redirecting to a relative location that carries terminal escapes. */
const hostile = () =>
  Promise.resolve(new Response(null, { headers: { location: '/x?\u001b[2Jgone' }, status: 302 }));

// A Location header is the answering server's text; only a parsed origin reaches the terminal.
test('a redirect to an unparsable location shows no target', async () => {
  const run = await runArgv(remoteApp(undefined, hostile), ['projects']);
  expect(run.stderr).toContain(`the host at ${ORIGIN} redirected`);
  expect(run.stderr).not.toContain('gone');
  expect(run.stderr).toContain('set [host] url to the address the host serves');
});

test.each([502, 503, 504])(
  'a proxy answering %i for a stopped host reads as unavailable',
  async (status) => {
    const proxy = () => Promise.resolve(new Response('', { status }));
    const run = await runArgv(remoteApp(undefined, proxy), ['projects']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`the host at ${ORIGIN} is unavailable (HTTP ${String(status)})`);
  },
);

// A url that names another JSON service or an API gateway answers JSON that is
// not the wire's envelope.
test.each([
  [404, '{"message":"Not Found"}'],
  [500, '{"error_code":"boom"}'],
  [500, '{"error":"boom"}'],
  [200, '{"result":5}'],
  [200, '{}'],
  [200, 'null'],
  [200, '[]'],
  [418, '"teapot"'],
])(
  'a JSON answer with HTTP %i and body %s is refused, not an internal error',
  async (status, body) => {
    const service = () =>
      Promise.resolve(
        new Response(body, { headers: { 'content-type': 'application/json' }, status }),
      );
    const run = await runArgv(remoteApp(undefined, service), ['projects']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`answered HTTP ${String(status)} without a Mimir response`);
    expect(run.stderr).not.toContain('UNHANDLED');
  },
);

// A url that names the wrong service, or a proxy's error or login page,
// answers without JSON.
test.each([200, 403, 404, 429, 500])(
  'an HTML answer with HTTP %i is refused, not an internal error',
  async (status) => {
    const page = () =>
      Promise.resolve(
        new Response('<html><body>not mimir</body></html>', {
          headers: { 'content-type': 'text/html' },
          status,
        }),
      );
    const run = await runArgv(remoteApp(undefined, page), ['projects']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `the host at ${ORIGIN} answered HTTP ${String(status)} without a Mimir response`,
    );
    expect(run.stderr).toContain('check that [host] url names a mimir host');
    expect(run.stderr).not.toContain('UNHANDLED');
  },
);

test.each([
  ['[host] beside [store]', { problem: 'with-store' }, 'both [host] and [store]'],
  [
    'an unusable [host] url',
    { problem: 'invalid-url' },
    "set [host] url to the host's http or https URL",
  ],
  [
    'a malformed [host]',
    { problem: 'malformed' },
    "set [host] url to the host's http or https URL",
  ],
] as const)('%s is refused before any request', async (_case, host, remedy) => {
  const run = await runArgv(remoteApp({ host, store: {} }), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(remedy);
  expect(requests).toEqual([]);
});

test('missing credentials are refused before any request', async () => {
  rmSync(credentialsFile);
  const run = await runArgv(remoteApp(), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`mimir pair ${ORIGIN}`);
  expect(requests).toEqual([]);
});

test('credentials that group or others can read are refused before any request', async () => {
  chmodSync(credentialsFile, 0o644);
  const run = await runArgv(remoteApp(), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`chmod 600 ${credentialsFile}`);
  expect(requests).toEqual([]);
});

test('credentials recorded for another host are refused before any request', async () => {
  const run = await runArgv(
    remoteApp({ host: { url: 'https://elsewhere.example.test' }, store: {} }),
    ['projects'],
  );
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('mimir pair https://elsewhere.example.test');
  expect(run.stderr).not.toContain(token);
  expect(requests).toEqual([]);
});

test.each([['store export -'], ['store import board.json --apply'], ['doctor']])(
  '%s refuses in remote mode and points to mimir-host',
  async (line) => {
    const run = await runArgv(remoteApp(), line.split(' '));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`lives on the host at ${ORIGIN}`);
    expect(run.stderr).toContain('docker exec mimir-host mimir-host');
    expect(requests).toEqual([]);
  },
);

// mimir-host never migrates: the host migrates its store when it starts (ADR 0038).
test('store upgrade in remote mode points to updating the host', async () => {
  const run = await runArgv(remoteApp(), ['store', 'upgrade']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('which migrates it when it starts');
  expect(run.stderr).toContain('update the host to upgrade its store');
  expect(run.stderr).not.toContain('mimir-host');
});

test.each([['store export -'], ['store upgrade'], ['doctor']])(
  '%s under a broken [host] refuses with the config fix',
  async (line) => {
    const run = await runArgv(
      remoteApp({ host: { problem: 'with-store' }, store: {} }),
      line.split(' '),
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('keep one: remove [store] to use the host');
  },
);

// The switch runMimir composes through: any `[host]` section means remote.
test('a config with any [host] section takes its work state from the host', async () => {
  const files = { configFile: join(dir, 'config.toml'), credentialsFile };
  expect(workStateSource({ store: {} }, opensStore, files)).toEqual({ store: opensStore });
  for (const host of [{ url: ORIGIN }, { problem: 'invalid-url' as const }]) {
    const source = workStateSource({ host, store: {} }, opensStore, files);
    if (!('remote' in source)) {
      throw new Error('expected a remote source');
    }
    const run = await runArgv(createApp({ git: boundClone('MMR'), ...source }), ['projects']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).not.toContain('remote mode opened a local store');
  }
});

test('a run that needs no work state reads no credentials', async () => {
  rmSync(credentialsFile);
  const run = await runArgv(remoteApp(), ['version']);
  expect(run.exitCode).toBe(0);
});
