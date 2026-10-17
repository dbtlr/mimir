import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath, warnConfigPermissions } from '@mimir/core';

import { readHostConfig } from './config';
import { openHost } from './host';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('host migrates a named SQLite directory and preserves writes after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-'));
  roots.push(root);
  const directory = join(root, 'data');
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: directory }), 'host-test');
  try {
    const health = await host.handle(new Request('http://localhost/api/health'));
    expect(await health.json()).toMatchObject({ status: 'ok', version: 'host-test' });
    const create = await host.handle(
      new Request('http://localhost/api/projects', {
        body: JSON.stringify({ key: 'TST', name: 'Disposable container project' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(create.status).toBe(201);
  } finally {
    await host.close();
  }
  const reopened = await openHost(await readHostConfig({ MIMIR_DATA_DIR: directory }), 'host-test');
  try {
    const projects = await reopened.handle(new Request('http://localhost/api/projects'));
    expect(await projects.json()).toMatchObject({
      items: [{ id: 'TST', title: 'Disposable container project' }],
    });
  } finally {
    await reopened.close();
  }
});

test('development host refuses Postgres without authority before connecting', async () => {
  const saved = process.env.MIMIR_SANDBOX_AUTHORITY;
  delete process.env.MIMIR_SANDBOX_AUTHORITY;
  try {
    const config = await readHostConfig({
      MIMIR_DATABASE_URL: 'postgres://live:secret@production.invalid/live',
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(openHost(config, 'test')).rejects.toThrow('registered live installation');
  } finally {
    if (saved !== undefined) {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});

test('host doctor reports stored record findings and project scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-doctor-'));
  roots.push(root);
  const host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: root }), 'test');
  try {
    const created = await host.handle(
      new Request('http://localhost/api/projects', {
        body: JSON.stringify({ key: 'TST', name: 'Doctor fixture' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(created.status).toBe(201);
    // A hand-edited timestamp models corruption the diagnostic must report.
    const database = new Database(join(root, 'store.sqlite'));
    try {
      database.run("UPDATE project SET created_at = 'invalid' WHERE key = 'TST'");
    } finally {
      database.close();
    }
    const findings = await host.handle(new Request('http://localhost/api/doctor'));
    expect(await findings.json()).toMatchObject({
      finding_total: 1,
      groups: [{ project: 'TST', records: [{ cause: 'malformed timestamp', id: 'TST' }] }],
      scope: null,
    });
    const scoped = await host.handle(new Request('http://localhost/api/doctor?project=TST'));
    expect(await scoped.json()).toMatchObject({
      finding_total: 1,
      scope: { key: 'TST', matched_records: 1 },
    });
    const other = await host.handle(new Request('http://localhost/api/doctor?project=OTH'));
    expect(await other.json()).toMatchObject({
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
    host = await openHost(await readHostConfig({ MIMIR_DATA_DIR: paths.data }), 'test');
    const facet = await host.handle(new Request('http://localhost/api/doctor'));
    expect(await facet.json()).toMatchObject({ finding_total: 0, groups: [], scope: null });
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
  const host = await openHost(config, 'test', (line) => logs.push(line));
  await host.close();
  expect(logs).toContain('host: applied migration 0005_project_pinned');
  logs.length = 0;
  const current = await openHost(config, 'test', (line) => logs.push(line));
  await current.close();
  expect(logs).toEqual([]);
  const database = new Database(join(root, 'store.sqlite'));
  database.run(
    "INSERT INTO schema_version (version, applied_at) VALUES (999, '2026-01-01T00:00:00Z')",
  );
  database.close();
  let refusal: unknown;
  try {
    await openHost(config, 'test');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal instanceof Error ? refusal.message : '').toContain('update the image');
});
