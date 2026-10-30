/**
 * Remote mode (ADR 0038, MMR-578): with `[host] url` in the config, the CLI
 * reaches work state through RemoteEngine and never opens a store. Each case
 * runs the real composition against an in-process host: the wire handler over
 * a test store, with its version window and bearer check.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MIN_CLIENT } from '@mimir/contract';
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
  if (new URL(request.url).pathname === '/health') {
    return Promise.resolve(
      Response.json({ minClient: MIN_CLIENT, schema: 1, status: 'ok', version: hostVersion }),
    );
  }
  return createEngineHandler(new LocalEngine(fixture.store), {
    verifyToken: fixture.tokens.verify,
    version: hostVersion,
  })(request);
}

/** A local-store edge remote mode must never reach. */
const opensStore = (): never => {
  throw new Error('remote mode opened a local store');
};

/** A host whose credential store fails: every request is an internal fault. */
function faultyHost(request: Request): Promise<Response> {
  return createEngineHandler(new LocalEngine(fixture.store), {
    verifyToken: () => Promise.reject(new Error('the token store is down')),
    version: hostVersion,
  })(request);
}

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
      openSqlite: opensStore,
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

// The host answers its own fault with an error envelope that carries no
// domain refusal.
test('a fault inside the host is refused with its message, not an internal error', async () => {
  const run = await runArgv(remoteApp(undefined, faultyHost), ['projects']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`the host at ${ORIGIN} could not complete the request`);
  expect(run.stderr).toContain('mimir-host doctor');
  expect(run.stderr).not.toContain('UNHANDLED');
});

test.each(['{"result":{}}', '{"error":{}}', '{"result":{"data":null}}', '{"error":{"json":{}}}'])(
  'an envelope-shaped answer the wire cannot read (%s) is refused',
  async (body) => {
    const malformed = () => Promise.resolve(new Response(body, { status: 200 }));
    const run = await runArgv(remoteApp(undefined, malformed), ['projects']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`the host at ${ORIGIN}`);
    expect(run.stderr).not.toContain('UNHANDLED');
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

test.each([['store export -'], ['store import board.json --apply']])(
  '%s refuses in remote mode and points to mimir-host',
  async (line) => {
    const run = await runArgv(remoteApp(), line.split(' '));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`lives on the host at ${ORIGIN}`);
    expect(run.stderr).toContain('inside the host container: mimir-host');
    expect(requests).toEqual([]);
  },
);

test.each([['store export -']])(
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

// Client diagnosis must report broken setup before any Engine is built.
test('remote doctor reports conflicting config as a finding and exits zero', async () => {
  const run = await runArgv(remoteApp({ host: { problem: 'with-store' }, store: {} }), [
    'doctor',
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-config',
      remedy: 'keep one: remove [store] to use the host, or remove [host] to use the local store',
      severity: 'error',
    },
  ]);
  expect(requests).toEqual([]);
  expect(run.stderr).toBe('');
});

test('remote doctor reports missing credentials before reaching the host', async () => {
  rmSync(credentialsFile);
  const run = await runArgv(remoteApp(), ['doctor', '-f', 'json']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-credentials',
      remedy: `mimir pair ${ORIGIN}`,
      severity: 'error',
    },
  ]);
  expect(requests).toEqual([]);
});

test.each([0o644, 0o400, 0o700])(
  'remote doctor requires credentials at exactly 0600, not %i',
  async (mode) => {
    chmodSync(credentialsFile, mode);
    const run = await runArgv(remoteApp(), ['doctor', '-f', 'json']);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([
      {
        check: 'remote-credentials',
        remedy: `chmod 600 ${credentialsFile}`,
      },
    ]);
    expect(requests).toEqual([]);
  },
);

test('remote doctor checks the recorded origin before reaching the host', async () => {
  const run = await runArgv(
    remoteApp({ host: { url: 'https://elsewhere.example.test' }, store: {} }),
    ['doctor', '-f', 'json'],
  );
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-origin',
      remedy: 'mimir pair https://elsewhere.example.test',
    },
  ]);
  expect(run.stdout).not.toContain(token);
  expect(requests).toEqual([]);
});

test('remote doctor reports an unreachable health endpoint without a token request', async () => {
  const run = await runArgv(remoteApp(undefined, down), ['doctor', '-f', 'json']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-health',
      remedy: 'check the host URL and that the host is running, then try again',
    },
  ]);
  expect(run.stdout).not.toContain(token);
});

test('remote doctor stops at the version window before sending credentials', async () => {
  hostVersion = '0.1.0';
  const run = await runArgv(remoteApp(), ['doctor', '-f', 'json']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-version',
      remedy: 'update the host first, then retry',
    },
  ]);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/health']);
  expect(requests[0]?.headers.get('authorization')).toBe(null);
  expect(requests[0]?.headers.get('x-mimir-version')).toBe(null);
});

test('remote doctor reports a revoked token after a healthy compatible host', async () => {
  await fixture.tokens.revoke('valhalla');
  const run = await runArgv(remoteApp(), ['doctor', '-f', 'jsonl']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({
    check: 'remote-token',
    remedy: `mimir pair ${ORIGIN}`,
  });
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/health',
    '/trpc/projects',
  ]);
  expect(run.stderr).toBe('');
  expect(run.stdout).not.toContain(token);
});

test('remote doctor reports every passed check and points record health to the host', async () => {
  const run = await runArgv(remoteApp(), ['doctor', '-s', 'MISSING'], {
    env: { NO_COLOR: '1' },
    tty: true,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain('[ok] host configuration');
  expect(run.stderr).toContain('[ok] credentials file (0600)');
  expect(run.stderr).toContain('[ok] credentials origin');
  expect(run.stderr).toContain('[ok] host health');
  expect(run.stderr).toContain('[ok] version window');
  expect(run.stderr).toContain('[ok] device token');
  expect(run.stderr.trim()).toEndWith(
    'record health: run mimir-host doctor inside the host container',
  );
  expect(run.stderr).not.toContain('matched 0 records');
  expect(run.stdout).toContain('doctor: no problems found');
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/health',
    '/trpc/projects',
  ]);
  expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${token}`);
  expect(requests[1]?.headers.get('x-mimir-version')).toBe(VERSION);
});

test.each([
  ['[host] without a URL', { problem: 'invalid-url' }],
  ['a malformed [host]', { problem: 'malformed' }],
] as const)('remote doctor diagnoses %s without a request', async (_label, host) => {
  const run = await runArgv(remoteApp({ host, store: {} }), ['doctor', '-f', 'json']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-config',
      remedy: "set [host] url to the host's http or https URL",
    },
  ]);
  expect(requests).toEqual([]);
});

test('remote doctor keeps successful machine output as an empty findings array', async () => {
  const run = await runArgv(remoteApp(), ['doctor', '-f', 'json']);
  expect(run).toMatchObject({ exitCode: 0, stderr: '' });
  expect(JSON.parse(run.stdout)).toEqual([]);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/health',
    '/trpc/projects',
  ]);
});

test('remote doctor prints only passed checks before the first failure and its fix', async () => {
  chmodSync(credentialsFile, 0o644);
  const run = await runArgv(remoteApp(), ['doctor'], { env: { NO_COLOR: '1' }, tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain('[ok] host configuration\n');
  expect(run.stderr).toContain('[err] client:');
  expect(run.stderr).toContain(`\n  fix: chmod 600 ${credentialsFile}`);
  expect(run.stderr).not.toContain('[ok] credentials');
  expect(run.stderr.trim()).toEndWith(
    'record health: run mimir-host doctor inside the host container',
  );
  expect(run.stdout).toBe('');
  expect(requests).toEqual([]);
});

test.each([
  { minClient: '99.0.0', remedy: 'update this CLI, then retry', version: VERSION },
  {
    minClient: MIN_CLIENT,
    remedy: 'check the CLI and host versions, and update them to compatible releases',
    version: 'invalid-host-version\u001b[2J',
  },
])(
  'remote doctor explains an incompatible window ($minClient, $version)',
  async ({ minClient, version, remedy }) => {
    const service: HostSend = (request) => {
      requests.push(request);
      return Promise.resolve(Response.json({ minClient, schema: 1, status: 'ok', version }));
    };
    const run = await runArgv(remoteApp(undefined, service), ['doctor', '-f', 'json']);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([{ check: 'remote-version', remedy }]);
    expect(run.stdout).not.toContain('invalid-host-version');
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/health']);
  },
);

test('remote doctor needs no local machine or clone-binding service', async () => {
  const app = createApp({
    git: {
      originUrl: opensStore,
      readConfig: opensStore,
      writeConfig: opensStore,
    },
    remote: remoteSource({
      config: { host: { url: ORIGIN }, store: {} },
      configFile: join(dir, 'config.toml'),
      credentialsFile,
      fetch: hostFetch,
    }),
  });
  const run = await runArgv(app, ['doctor', '-f', 'json']);
  expect(run).toMatchObject({ exitCode: 0, stderr: '' });
  expect(JSON.parse(run.stdout)).toEqual([]);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/health',
    '/trpc/projects',
  ]);
});

test.each([
  'garbage = [',
  `origin = "${ORIGIN}"\ndevice = "valhalla"\nissued_at = "2026-10-20T12:00:00Z"\n`,
])(
  'remote doctor classifies unreadable credential records as credentials failures',
  async (text) => {
    writeFileSync(credentialsFile, text);
    const run = await runArgv(remoteApp(), ['doctor', '-f', 'json']);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([
      { check: 'remote-credentials', remedy: `mimir pair ${ORIGIN}` },
    ]);
    expect(requests).toEqual([]);
  },
);

/** Health answers, but the token response's stream fails after its headers. */
const unfinishedTokenResponse: HostSend = (request) => {
  if (new URL(request.url).pathname === '/health') {
    return hostFetch(request);
  }
  requests.push(request);
  return Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException('response timed out', 'TimeoutError'));
        },
      }),
    ),
  );
};

test('remote doctor gives a retry remedy when the token response body does not finish', async () => {
  const run = await runArgv(remoteApp(undefined, unfinishedTokenResponse), [
    'doctor',
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject([
    {
      check: 'remote-token',
      remedy:
        'check the host and proxy are responding, then retry; check the host logs if it persists',
    },
  ]);
  expect(run.stdout).not.toContain('without a Mimir response');
});

test('clean remote JSONL preserves the existing empty-report newline', async () => {
  const run = await runArgv(remoteApp(), ['doctor', '-f', 'jsonl']);
  expect(run).toEqual({ exitCode: 0, stderr: '', stdout: '\n' });
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/health',
    '/trpc/projects',
  ]);
});
