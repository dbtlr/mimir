import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('host logs applied SQLite migrations and refuses a schema ahead with an image remedy', async () => {
  const { Database } = await import('bun:sqlite');
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
