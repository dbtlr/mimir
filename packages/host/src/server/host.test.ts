import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath, SQLITE_FILE, warnConfigPermissions } from '@mimir/core';
import { RemoteEngine } from '@mimir/wire/client';

import { readHostConfig } from './config';
import { guardEveryRoute, hostGuard } from './guard';
import { openHost } from './host';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('the host shares Engine reads and completions over tRPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-engine-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0');
  const server = Bun.serve({
    fetch: (request) => host.handleTrpc(request),
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    const unpaired = new RemoteEngine({
      url: new URL('/trpc', server.url).href,
      version: '0.26.0',
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
      version: '0.26.0',
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
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: directory }), '0.26.0');
  try {
    await host.engine.create({ key: 'TST', name: 'Disposable container project', type: 'project' });
  } finally {
    await host.close();
  }
  const reopened = await openHost(await readHostConfig({ MIMIR_DATA_DIR: directory }), '0.26.0');
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
    await expect(openHost(config, '0.26.0')).rejects.toThrow('registered live installation');
  } finally {
    if (saved !== undefined) {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});

test('host doctor reports stored record findings and project scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-doctor-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0');
  try {
    await host.engine.create({ key: 'TST', name: 'Doctor fixture', type: 'project' });
    // A hand-edited timestamp models corruption the diagnostic must report.
    const database = new Database(join(root, 'store.sqlite'));
    try {
      database.run("UPDATE project SET created_at = 'invalid' WHERE key = 'TST'");
    } finally {
      database.close();
    }
    expect(await host.doctor(undefined)).toMatchObject({
      finding_total: 1,
      groups: [{ project: 'TST', records: [{ cause: 'malformed timestamp', id: 'TST' }] }],
      scope: null,
    });
    expect(await host.doctor('TST')).toMatchObject({
      finding_total: 1,
      scope: { key: 'TST', matched_records: 1 },
    });
    expect(await host.doctor('OTH')).toMatchObject({
      finding_total: 0,
      groups: [],
      scope: { key: 'OTH', matched_records: 0 },
    });
  } finally {
    await host.close();
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
    host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: paths.data }), '0.26.0');
    expect(await host.doctor(undefined)).toMatchObject({
      finding_total: 0,
      groups: [],
      scope: null,
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
  const host = await openHost(config, '0.26.0', (line) => logs.push(line));
  await host.close();
  expect(logs).toContain('host: applied migration 0005_project_pinned');
  logs.length = 0;
  const current = await openHost(config, '0.26.0', (line) => logs.push(line));
  await current.close();
  expect(logs).toEqual([]);
  const database = new Database(join(root, 'store.sqlite'));
  database.run(
    "INSERT INTO schema_version (version, applied_at) VALUES (999, '2026-01-01T00:00:00Z')",
  );
  database.close();
  let refusal: unknown;
  try {
    await openHost(config, '0.26.0');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal instanceof Error ? refusal.message : '').toContain('update the image');
});

const total = (groups: { findings: number }[]) =>
  groups.reduce((sum, group) => sum + group.findings, 0);

test('the host Engine counts stored record findings in console.review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-review-findings-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0');
  try {
    await host.engine.create({ key: 'TST', name: 'Findings fixture', type: 'project' });
    const database = new Database(join(root, 'store.sqlite'));
    try {
      database.run("UPDATE project SET created_at = 'invalid' WHERE key = 'TST'");
    } finally {
      database.close();
    }
    const page = await host.engine.console.review({ timeZone: 'UTC' });
    expect(total(page.triage)).toBe(1);
  } finally {
    await host.close();
  }
});

test('Host guard, version window, and bearer check run in order while local Engine calls stay outside them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-window-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), '0.26.0');
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
        headers: { host: 'allowed.test', 'x-mimir-version': '0.26.0' },
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
