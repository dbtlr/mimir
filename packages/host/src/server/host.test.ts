import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpSdkServerConfigWithInstance, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  configPath,
  parseSecretKey,
  sealSecret,
  SQLITE_FILE,
  warnConfigPermissions,
} from '@mimir/core';
import { WINDOW_VERSION } from '@mimir/core/testing';
import { RemoteEngine } from '@mimir/wire/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { RunQuery } from './agent-runner';
import { readHostConfig } from './config';
import { guardEveryRoute, hostGuard } from './guard';
import { openHost } from './host';
import type { HostDependencies, NotifierTimer } from './host';
import { decryptPushBody, makeBrowserKeys } from './push-fixtures';
import { stubPushService } from './push-stub';
import { T3_SECRET_NAME } from './t3';
import { parseT3LaunchInput } from './t3-input';
import { STUB_ACCESS_TOKEN, stubT3 } from './t3-stub';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('the host shares Engine reads and completions over tRPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-engine-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), WINDOW_VERSION);
  const server = Bun.serve({
    fetch: (request) => host.handleTrpc(request),
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    const unpaired = new RemoteEngine({
      url: new URL('/trpc', server.url).href,
      version: WINDOW_VERSION,
    });
    const refusal: unknown = await unpaired.projects({}).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      data: { code: 'UNAUTHORIZED', httpStatus: 401 },
      message: 'unauthorized',
    });
    const filed = await host.handlePairingRequest(
      new Request('http://host.test/auth/pairing/requests', {
        body: JSON.stringify({ device: 'host-test' }),
        method: 'POST',
      }),
    );
    expect(filed.status).toBe(200);
    const request = await filed.json();
    await host.tokens.approve(request.user_code);
    const response = await host.handlePairingPoll(
      new Request('http://host.test/auth/pairing/poll', {
        body: JSON.stringify({ poll_secret: request.poll_secret }),
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    const { token } = await response.json();
    await host.engine.create({ key: 'TST', name: 'Engine fixture', type: 'project' });
    await host.engine.create({ parent: 'TST', title: 'Host Engine', type: 'initiative' });
    await host.engine.create({ parent: 'TST-1', title: 'Complete over tRPC', type: 'task' });
    const remote = new RemoteEngine({
      headers: { authorization: `Bearer ${token}` },
      url: new URL('/trpc', server.url).href,
      version: WINDOW_VERSION,
    });
    const read = await remote.getNode({ id: 'TST-2' });
    expect(read).toMatchObject({ lifecycle: 'todo', title: 'Complete over tRPC' });
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(read).toEqual(await host.engine.getNode({ id: 'TST-2' }));

    const completed = await remote.done({ id: 'TST-2' });
    expect(completed.lifecycle).toBe('done');
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(await host.engine.getNode({ id: 'TST-2' })).toEqual(
      await remote.getNode({ id: 'TST-2' }),
    );
  } finally {
    await server.stop(true);
    await host.close();
  }
});

test('host migrates a named SQLite directory and preserves writes after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-'));
  roots.push(root);
  const directory = join(root, 'data');
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: directory }), WINDOW_VERSION);
  try {
    await host.engine.create({ key: 'TST', name: 'Disposable container project', type: 'project' });
  } finally {
    await host.close();
  }
  const reopened = await openHost(
    await readHostConfig({ MIMIR_DATA_DIR: directory }),
    WINDOW_VERSION,
  );
  try {
    const projects = await reopened.engine.projects({});
    expect(projects).toMatchObject([{ id: 'TST', title: 'Disposable container project' }]);
  } finally {
    await reopened.close();
  }
});

test('an invalid host version is refused before the store is opened or migrated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-'));
  roots.push(root);
  const directory = join(root, 'data');
  const config = await readHostConfig({ MIMIR_DATA_DIR: directory });
  // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
  await expect(openHost(config, 'not-a-version')).rejects.toThrow(
    'invalid host version: not-a-version',
  );
  expect(await Bun.file(join(directory, SQLITE_FILE)).exists()).toBe(false);
});

test('development host refuses Postgres without authority before connecting', async () => {
  const saved = process.env.MIMIR_SANDBOX_AUTHORITY;
  delete process.env.MIMIR_SANDBOX_AUTHORITY;
  try {
    const config = await readHostConfig({
      MIMIR_DATABASE_URL: 'postgres://live:secret@production.invalid/live',
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(openHost(config, WINDOW_VERSION)).rejects.toThrow('registered live installation');
  } finally {
    if (saved !== undefined) {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});

test('host doctor excludes findings from an unsafe CLI configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-host-config-doctor-')));
  roots.push(root);
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  const authority = join(root, 'authority.json');
  await writeFile(
    authority,
    JSON.stringify({ id: randomUUID(), kind: 'local', paths, root, version: 1 }),
  );
  const file = join(paths.config, 'config.toml');
  await writeFile(file, '[store]\nbackend = "sqlite"\n');
  await chmod(file, 0o666);
  const saved = process.env.MIMIR_SANDBOX_AUTHORITY;
  process.env.MIMIR_SANDBOX_AUTHORITY = authority;
  let host: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    expect(configPath()).toBe(file);
    const warnings: string[] = [];
    warnConfigPermissions(undefined, file, (line) => warnings.push(line));
    expect(warnings.join('\n')).toContain('chmod 600');
    host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: paths.data }), WINDOW_VERSION);
    expect(await host.doctor(undefined)).toMatchObject({
      finding_total: 0,
      groups: [],
      scope: null,
    });
    // The console's per-project Record health passes its project through the host.
    expect(await host.doctor('OTH')).toMatchObject({
      scope: { key: 'OTH', matched_records: 0 },
    });
  } finally {
    await host?.close();
    if (saved === undefined) {
      delete process.env.MIMIR_SANDBOX_AUTHORITY;
    } else {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});

test('host logs applied SQLite migrations and refuses a schema ahead with an image remedy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-schema-'));
  roots.push(root);
  const config = await readHostConfig({ MIMIR_DATA_DIR: root });
  const logs: string[] = [];
  const host = await openHost(config, WINDOW_VERSION, (line) => logs.push(line));
  await host.close();
  expect(logs).toContain('host: applied migration 0005_project_pinned');
  logs.length = 0;
  const current = await openHost(config, WINDOW_VERSION, (line) => logs.push(line));
  await current.close();
  expect(logs).toEqual([]);
  const database = new Database(join(root, 'store.sqlite'));
  database.run(
    "INSERT INTO schema_version (version, applied_at) VALUES (999, '2026-01-01T00:00:00Z')",
  );
  database.close();
  let refusal: unknown;
  try {
    await openHost(config, WINDOW_VERSION);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal instanceof Error ? refusal.message : '').toContain('update the image');
});

const total = (projects: { findings: number }[]) =>
  projects.reduce((sum, project) => sum + project.findings, 0);

test('the host Engine counts stored record findings in console.review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-review-findings-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), WINDOW_VERSION);
  try {
    await host.engine.create({ key: 'TST', name: 'Findings fixture', type: 'project' });
    const database = new Database(join(root, 'store.sqlite'));
    try {
      database.run("UPDATE project SET created_at = 'invalid' WHERE key = 'TST'");
    } finally {
      database.close();
    }
    const page = await host.engine.console.review({ timeZone: 'UTC' });
    expect(total(page.projects)).toBe(1);
  } finally {
    await host.close();
  }
});

test('Host guard, version window, and bearer check run in order while local Engine calls stay outside them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-window-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), WINDOW_VERSION);
  const log = spyOn(console, 'error').mockReturnValue(undefined);
  try {
    const guarded = guardEveryRoute(host.handleTrpc, Promise.resolve(hostGuard(['allowed.test'])));
    const forbidden = await guarded(
      new Request('http://allowed.test/trpc/projects', {
        headers: { host: 'refused.test' },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden_host' } });
    const missing = await guarded(
      new Request('http://allowed.test/trpc/projects', {
        headers: { host: 'allowed.test' },
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('missing x-mimir-version');
    const unauthorized = await guarded(
      new Request('http://allowed.test/trpc/projects', {
        headers: { host: 'allowed.test', 'x-mimir-version': WINDOW_VERSION },
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { json: { message: 'unauthorized' } },
    });
    expect(await host.engine.projects({})).toEqual([]);
  } finally {
    log.mockRestore();
    await host.close();
  }
});

test('a host with T3 misconfigured boots, warns by setting name, and reports the problem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-t3-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({
      MIMIR_DATA_DIR: root,
      MIMIR_HOSTS: '',
      MIMIR_T3_URL: 'https://t3.example',
    }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(lines.filter((line) => line.includes('T3 Code'))).toEqual([
      expect.stringContaining('MIMIR_SECRET_KEY is missing'),
    ]);
    expect(await host.t3.status('http://localhost:64647')).toEqual({
      problem: 'missing',
      setting: 'MIMIR_SECRET_KEY',
      state: 'misconfigured',
    });
    const callback = await host.handleT3Callback(
      new Request('http://localhost:64647/auth/t3/callback?state=x&code=y'),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/settings/connections?t3=misconfigured');
    const database = new Database(join(root, SQLITE_FILE), { readonly: true });
    try {
      expect(database.query('select name from host_secrets').all()).toEqual([]);
    } finally {
      database.close();
    }
  } finally {
    await host.close();
  }
});

test('a host without MIMIR_T3_URL logs nothing about T3', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-no-t3-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({ MIMIR_DATA_DIR: root, MIMIR_SECRET_KEY: 'not a key' }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(lines.filter((line) => line.includes('T3'))).toEqual([]);
    expect(await host.t3.status('http://localhost:64647')).toEqual({ state: 'unconfigured' });
  } finally {
    await host.close();
  }
});

test('an unreadable git credentials file warns by setting name at boot, and nothing is cloned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-git-credentials-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({
      MIMIR_DATA_DIR: root,
      MIMIR_GIT_CREDENTIALS_FILE: join(root, 'missing-credentials'),
    }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(lines.filter((line) => line.includes('MIMIR_GIT_CREDENTIALS_FILE'))).toEqual([
      expect.stringContaining('MIMIR_GIT_CREDENTIALS_FILE is unreadable'),
    ]);
    expect(lines.join('\n')).not.toContain('missing-credentials');
    expect(await readdir(root)).not.toContain('clones');
    expect(await readdir(root)).not.toContain('git');
  } finally {
    await host.close();
  }
});

test('a misconfigured agent runtime warns by setting name at boot and still opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-agent-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({
      MIMIR_AGENT_MAX_TURNS: 'many',
      MIMIR_AGENT_TOKEN_FILE: join(root, 'missing-token'),
      MIMIR_DATA_DIR: root,
    }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(
      lines.filter((line) => line.includes('MIMIR_AGENT') || line.includes('MIMIR_HOSTS')),
    ).toEqual([
      '⚠ host: agent runs are not set up: MIMIR_AGENT_TOKEN_FILE is unreadable; agent runs stay off until it is fixed',
      '⚠ host: agent runs are not set up: MIMIR_HOSTS is unset; agent runs stay off until it is fixed',
      '⚠ host: MIMIR_AGENT_MAX_TURNS is invalid; agent runs use 50',
    ]);
    expect(lines.join('\n')).not.toContain('missing-token');
  } finally {
    await host.close();
  }
});

test('the host interrupts a stale run at boot and exposes the runs, the agent runner, and its console', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-runs-'));
  roots.push(root);
  const config = await readHostConfig({ MIMIR_DATA_DIR: root });
  const first = await openHost(config, WINDOW_VERSION, () => {});
  await first.runs.admit({
    budget: { dailyTokens: 1_000, since: '2000-01-01T00:00:00.000Z' },
    id: 'dead-run',
    kind: 'groom',
    model: 'claude-opus-5-5',
    project: 'TST',
    reservedTokens: 100,
    runner: 'old-container',
    staleAfterMs: 1,
    task: 'TST-1',
    trigger: 'console',
  });
  // Its heartbeat ages past the stale window while no host runs.
  await first.close();
  const database = new Database(join(root, SQLITE_FILE));
  database.run("UPDATE runs SET heartbeat_at = '2000-01-01T00:00:00.000Z'");
  database.close();

  const lines: string[] = [];
  const host = await openHost(config, WINDOW_VERSION, (line) => lines.push(line));
  try {
    expect((await host.runs.get('dead-run'))?.state).toBe('interrupted');
    expect(lines).toContain('host: interrupted 1 agent run whose runner stopped heartbeating');
    expect(await host.agent.status()).toEqual({
      agent: { state: 'unconfigured' },
      budget: null,
      managedPolicy: [],
      model: null,
      running: null,
    });
    // The console reads the same runner: no card, and no running run for Now.
    expect(await host.agentConsole.card({ project: 'TST', task: 'TST-1' })).toEqual({
      state: 'unconfigured',
    });
    expect(await host.agentConsole.activity()).toEqual({ running: null });
    expect(
      await host.agent.startRun({
        brief: { prompt: 'p', systemPrompt: 's' },
        kind: 'groom',
        project: 'TST',
        task: 'TST-1',
        trigger: 'console',
      }),
    ).toEqual({ reason: 'unconfigured', started: false });
  } finally {
    await host.close();
  }
});

test('a fresh run of another host survives boot and keeps the slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-runs-'));
  roots.push(root);
  const config = await readHostConfig({ MIMIR_DATA_DIR: root });
  const first = await openHost(config, WINDOW_VERSION, () => {});
  await first.runs.admit({
    budget: { dailyTokens: 1_000, since: '2000-01-01T00:00:00.000Z' },
    id: 'live-run',
    kind: 'groom',
    model: 'claude-opus-5-5',
    project: 'TST',
    reservedTokens: 100,
    runner: 'overlapping-container',
    staleAfterMs: 120_000,
    task: 'TST-1',
    trigger: 'console',
  });
  await first.close();

  const lines: string[] = [];
  const host = await openHost(config, WINDOW_VERSION, (line) => lines.push(line));
  try {
    expect(await host.runs.running()).toMatchObject({ id: 'live-run', state: 'running' });
    expect(lines.filter((line) => line.includes('agent run'))).toEqual([]);
    expect((await host.agent.status()).running).toMatchObject({
      run: { id: 'live-run' },
      stale: false,
    });
  } finally {
    await host.close();
  }
});

/*
 * The notifier's wiring (ADR 0045), on the real `openHost`: which view each
 * caller gets, that boot runs, that close reaches the notifier, and that its
 * timers are unref'd. The test drives the notifier's time through the
 * `notifierTiming` seam, so no test waits on a real timer.
 */
/** Yield until `done` holds; the store's reads settle on their own. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 500 && !done(); turn += 1) {
    await Bun.sleep(0);
  }
  expect(done()).toBe(true);
}

function timedHost() {
  let monotonic = 1_000;
  const timers: {
    at: number;
    cancelled: boolean;
    run: () => void;
    unref: () => void;
    unrefd: boolean;
  }[] = [];
  const lines: Record<string, unknown>[] = [];
  const timing = {
    clearTimeout: (timer: unknown) => {
      const found = timers.find((candidate) => Object.is(candidate, timer));
      if (found !== undefined) {
        found.cancelled = true;
      }
    },
    monotonicNow: () => monotonic,
    setTimeout: (run: () => void, ms: number) => {
      const timer = {
        at: monotonic + ms,
        cancelled: false,
        run,
        unref: () => {
          timer.unrefd = true;
        },
        unrefd: false,
      };
      timers.push(timer);
      // The host asks only for `unref` and a handle to clear; this is a stand-in for a Timeout.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return timer as unknown as NotifierTimer;
    },
    wallNow: () => 1_700_000_000_000 + monotonic,
  };
  const log = (line: string) => {
    if (line.startsWith('{')) {
      const { time: _time, ...rest } = JSON.parse(line) as Record<string, unknown>;
      lines.push(rest);
    }
  };
  const armed = () => timers.filter((timer) => !timer.cancelled);
  const notifierLines = () => lines.filter((line) => String(line.event).startsWith('needs_you'));
  /** Fire every armed window, then wait for the check it starts to finish. */
  const closeWindow = async () => {
    const before = notifierLines().length;
    const due = armed().toSorted((a, b) => a.at - b.at);
    expect(due.length).toBeGreaterThan(0);
    for (const timer of due) {
      timer.cancelled = true;
      monotonic = Math.max(monotonic, timer.at);
      timer.run();
    }
    await Bun.sleep(0);
    return before;
  };
  return { armed, closeWindow, lines, log, notifierLines, timers, timing };
}

async function openTimedHost(
  options: { env?: Record<string, string>; remote?: string; dependencies?: HostDependencies } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-notifier-'));
  roots.push(root);
  const rig = timedHost();
  const host = await openHost(
    await readHostConfig({ MIMIR_DATA_DIR: root, ...options.env }),
    WINDOW_VERSION,
    rig.log,
    { ...options.dependencies, notifierTiming: rig.timing },
  );
  await host.engine.create({
    key: 'NTF',
    name: 'Notifier',
    type: 'project',
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  });
  await host.engine.create({ parent: 'NTF', title: 'Plan', type: 'initiative' });
  await host.engine.create({ parent: 'NTF-1', title: 'First', type: 'task' });
  await host.engine.create({ parent: 'NTF-1', title: 'Second', type: 'task' });
  // The setup writes opened a window; its check finds nothing.
  await rig.closeWindow();
  // The setup check is over once its read limit timer is cleared.
  await until(() => rig.armed().length === 0);
  return { host, rig, root };
}

async function pairedRemote(host: Awaited<ReturnType<typeof openHost>>) {
  const filed = await host.handlePairingRequest(
    new Request('http://host.test/auth/pairing/requests', {
      body: JSON.stringify({ device: 'notifier-test' }),
      method: 'POST',
    }),
  );
  const request = await filed.json();
  await host.tokens.approve(request.user_code);
  const polled = await host.handlePairingPoll(
    new Request('http://host.test/auth/pairing/poll', {
      body: JSON.stringify({ poll_secret: request.poll_secret }),
      method: 'POST',
    }),
  );
  const { token } = await polled.json();
  const server = Bun.serve({
    fetch: (incoming) => host.handleTrpc(incoming),
    hostname: '127.0.0.1',
    port: 0,
  });
  const remote = new RemoteEngine({
    headers: { authorization: `Bearer ${token}` },
    url: new URL('/trpc', server.url).href,
    version: WINDOW_VERSION,
  });
  return { remote, server };
}

test('a block made through /trpc is another actor, so the operator is told', async () => {
  const { host, rig } = await openTimedHost();
  const { remote, server } = await pairedRemote(host);
  try {
    await remote.block({ id: 'NTF-3', on: 'you', reason: 'Agent needs a key' });
    await rig.closeWindow();
    await until(() => rig.notifierLines().length > 0);
    expect(rig.notifierLines()).toEqual([
      {
        count: 1,
        event: 'needs_you_event',
        ids: 'NTF-3',
        kind: 'task_blocked',
        target: '/p/NTF/3',
      },
    ]);
  } finally {
    await server.stop(true);
    await host.close();
  }
});

/** A stand-in for the agent SDK: a run whose one write is grooming its task to needs answers. */
const groomingQuery: RunQuery = ({ options }) =>
  (async function* run() {
    // The run's one write, through its grant: the host's agent view of the Engine.
    const server = Object.values(options.mcpServers ?? {})[0] as McpSdkServerConfigWithInstance;
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'host-test', version: '1.0.0' });
    await client.connect(clientSide);
    await client.callTool({
      arguments: { note: 'Which region?', state: 'needs_answers' },
      name: 'groom',
    });
    await client.close();
    yield {
      modelUsage: {},
      subtype: 'success',
      type: 'result',
      usage: {},
    } as unknown as SDKMessage;
  })();

test('an agent run that grooms a task to needs answers is another actor, so the operator is told', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-agent-notifier-'));
  roots.push(root);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'sk-ant-oat01-test\n');
  const { host, rig } = await openTimedHost({
    dependencies: {
      agentRuntime: {
        query: groomingQuery,
        syncClone: async () => {
          const directory = join(root, 'clone');
          await mkdir(directory, { recursive: true });
          return { branch: 'main', commit: 'abc123', directory, fresh: true, ok: true };
        },
      },
    },
    env: {
      MIMIR_AGENT_TOKEN_FILE: tokenFile,
      MIMIR_HOSTS: 'github.com',
    },
    remote: 'https://github.com/acme/notifier',
  });
  try {
    const start = await host.agent.startRun({
      brief: { prompt: 'Groom the task.', systemPrompt: 'You groom tasks.' },
      kind: 'groom',
      project: 'NTF',
      task: 'NTF-3',
      trigger: 'console',
    });
    expect(start).toMatchObject({ started: true });
    if (start.started) {
      await start.finished;
    }
    await rig.closeWindow();
    await until(() => rig.notifierLines().length > 0);
    expect(rig.notifierLines()).toEqual([
      expect.objectContaining({
        event: 'needs_you_event',
        ids: 'NTF-3',
        kind: 'task_needs_answers',
      }),
    ]);
  } finally {
    await host.close();
  }
});

test('a T3 launch is the operator, so it does not tell the operator what the console did', async () => {
  const T3 = 'https://t3.example';
  const key = Buffer.alloc(32, 7).toString('base64');
  const stub = stubT3({
    configured: 'env-valhalla',
    environments: {
      'env-valhalla': {
        label: 'Valhalla',
        projects: [{ id: 'p-notifier', remoteUrl: 'git@github.com:acme/notifier.git', title: 'n' }],
        providers: [
          {
            displayName: 'Codex',
            models: [{ id: 'gpt-6.1-sol', options: [] }],
            providerInstanceId: 'codex',
          },
        ],
        runtimeMode: 'auto',
      },
    },
    links: [],
    origin: T3,
  });
  const { host, rig, root } = await openTimedHost({
    dependencies: { t3Fetch: stub.fetch },
    env: { MIMIR_HOSTS: 'github.com', MIMIR_SECRET_KEY: key, MIMIR_T3_URL: T3 },
    remote: 'https://github.com/acme/notifier',
  });
  try {
    // The operator's connection to T3, sealed as the OAuth callback seals it.
    const database = new Database(join(root, SQLITE_FILE));
    database
      .query(
        'INSERT INTO host_secrets (name, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        T3_SECRET_NAME,
        sealSecret(
          parseSecretKey(key)!,
          T3_SECRET_NAME,
          JSON.stringify({
            accessToken: STUB_ACCESS_TOKEN,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            issuer: T3,
          }),
        ),
        'now',
        'now',
      );
    database.close();
    // The console's own write opens a window and would be withheld by itself.
    await host.engine.block({ id: 'NTF-3', on: 'you', reason: 'Console help' });
    const launched = await host.t3.launch(
      parseT3LaunchInput({
        attempt: 'attempt-0000000001',
        environmentId: 'env-valhalla',
        interactionMode: 'default',
        model: { instanceId: 'codex', model: 'gpt-6.1-sol', options: [] },
        projectId: 'p-notifier',
        runtimeMode: 'auto',
        task: 'NTF-2',
        workspace: { type: 'worktree' },
      }),
    );
    expect(launched).toMatchObject({ state: 'launched' });
    await rig.closeWindow();
    await until(() => rig.notifierLines().length > 0);
    expect(rig.notifierLines()).toEqual([{ event: 'needs_you_withheld', ids: 'NTF-3' }]);
  } finally {
    await host.close();
  }
});

test('a block made through the console engine is the operator, so it is withheld', async () => {
  const { host, rig } = await openTimedHost();
  try {
    await host.engine.block({ id: 'NTF-3', on: 'you', reason: 'Console help' });
    await rig.closeWindow();
    await until(() => rig.notifierLines().length > 0);
    expect(rig.notifierLines()).toEqual([{ event: 'needs_you_withheld', ids: 'NTF-3' }]);
  } finally {
    await host.close();
  }
});

test('the host boots the notifier: an entry already in the set is no news, a new one is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-notifier-boot-'));
  roots.push(root);
  const config = await readHostConfig({ MIMIR_DATA_DIR: root });
  const first = await openHost(config, WINDOW_VERSION, () => {});
  await first.engine.create({ key: 'NTF', name: 'Notifier', type: 'project' });
  await first.engine.create({ parent: 'NTF', title: 'Plan', type: 'initiative' });
  await first.engine.create({ parent: 'NTF-1', title: 'First', type: 'task' });
  await first.engine.create({ parent: 'NTF-1', title: 'Second', type: 'task' });
  await first.engine.block({ id: 'NTF-2', on: 'you', reason: 'Already waiting' });
  await first.close();
  const rig = timedHost();
  const host = await openHost(config, WINDOW_VERSION, rig.log, { notifierTiming: rig.timing });
  const { remote, server } = await pairedRemote(host);
  try {
    await remote.block({ id: 'NTF-3', on: 'you', reason: 'New' });
    await rig.closeWindow();
    await until(() => rig.notifierLines().length > 0);
    expect(rig.notifierLines().map((line) => line.ids)).toEqual(['NTF-3']);
  } finally {
    await server.stop(true);
    await host.close();
  }
});

test('closing the host closes the notifier: its window is cancelled and nothing is logged', async () => {
  const { host, rig } = await openTimedHost();
  await host.engine.block({ id: 'NTF-3', on: 'you', reason: 'Console help' });
  expect(rig.armed()).toHaveLength(1);
  const logged = rig.notifierLines().length;
  await host.close();
  expect(rig.armed()).toEqual([]);
  expect(rig.notifierLines()).toHaveLength(logged);
});

test('every timer the notifier arms is unref, so an open window never holds the process', async () => {
  const { host, rig } = await openTimedHost();
  try {
    await host.engine.block({ id: 'NTF-3', on: 'you', reason: 'Console help' });
    expect(rig.timers.length).toBeGreaterThan(1);
    expect(rig.timers.every((timer) => timer.unrefd)).toBe(true);
  } finally {
    await host.close();
  }
});

async function untilWithin(ms: number, done: () => boolean) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(done()).toBe(true);
}

const PUSH_ENV = {
  MIMIR_HOSTS: 'mimir.example',
  MIMIR_PUSH_CONTACT: 'mailto:operator@example.net',
  MIMIR_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  MIMIR_URL: 'https://mimir.example',
};

test('a host with Web Push set up sends a block by another actor to a subscribed device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-push-'));
  roots.push(root);
  const rig = timedHost();
  const service = stubPushService();
  const host = await openHost(
    await readHostConfig({ ...PUSH_ENV, MIMIR_DATA_DIR: root }),
    WINDOW_VERSION,
    rig.log,
    { notifierTiming: rig.timing, pushFetch: service.fetch },
  );
  const { remote, server } = await pairedRemote(host);
  try {
    await host.engine.create({ key: 'NTF', name: 'Notifier', type: 'project' });
    await host.engine.create({ parent: 'NTF', title: 'Plan', type: 'initiative' });
    await host.engine.create({ parent: 'NTF-1', title: 'First', type: 'task' });
    await rig.closeWindow();
    await until(() => rig.armed().length === 0);
    const status = await host.push.status();
    if (status.state !== 'ready') {
      throw new Error(status.state);
    }
    const browser = await makeBrowserKeys();
    const endpoint = 'https://web.push.apple.com/host-device';
    expect(
      await host.push.subscribe(
        { ...browser, endpoint, label: 'Phone', serverKey: status.publicKey },
        'https://mimir.example',
      ),
    ).toEqual({ state: 'subscribed' });
    await remote.block({ id: 'NTF-2', on: 'you', reason: 'Agent needs a key' });
    await rig.closeWindow();
    // Encryption and signing run on WebCrypto's threads, so wait by time, not by turns.
    await untilWithin(5_000, () => service.requests.length > 0);
    const [request] = service.requests;
    expect(request?.endpoint).toBe(endpoint);
    expect(JSON.parse(await decryptPushBody(request!.body, browser))).toMatchObject({
      app_badge: 1,
      notification: {
        navigate: 'https://mimir.example/p/NTF/2',
        tag: 'task_blocked:/p/NTF/2',
        title: 'First',
      },
      web_push: 8030,
    });
  } finally {
    await server.stop(true);
    await host.close();
  }
});

test('a host with Web Push misconfigured boots, warns by setting name, and writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-push-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({
      MIMIR_DATA_DIR: root,
      MIMIR_PUSH_CONTACT: 'mailto:operator@example.net',
      MIMIR_URL: 'https://mimir.example',
    }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(lines.filter((line) => line.includes('Web Push'))).toEqual([
      expect.stringContaining('MIMIR_HOSTS is unset'),
      expect.stringContaining('MIMIR_SECRET_KEY is missing'),
    ]);
    expect(await host.push.status()).toEqual({
      problem: 'unset',
      setting: 'MIMIR_HOSTS',
      state: 'misconfigured',
    });
    const database = new Database(join(root, SQLITE_FILE), { readonly: true });
    try {
      expect(database.query('select name from host_secrets').all()).toEqual([]);
      expect(database.query('select endpoint from push_subscriptions').all()).toEqual([]);
    } finally {
      database.close();
    }
  } finally {
    await host.close();
  }
});

test('a host without MIMIR_PUSH_CONTACT logs nothing about Web Push and answers unconfigured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-no-push-'));
  roots.push(root);
  const lines: string[] = [];
  const host = await openHost(
    await readHostConfig({ MIMIR_DATA_DIR: root }),
    WINDOW_VERSION,
    (line) => lines.push(line),
  );
  try {
    expect(lines.filter((line) => line.includes('Web Push'))).toEqual([]);
    expect(await host.push.status()).toEqual({ state: 'unconfigured' });
  } finally {
    await host.close();
  }
});
