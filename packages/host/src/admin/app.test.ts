import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import { createProject } from '@mimir/core';

import { adminFixture } from './testing';
import type { AdminFixture } from './testing';

const fixtures: AdminFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
async function fixtureOf(create = true): Promise<AdminFixture> {
  const fixture = await adminFixture({ create });
  fixtures.push(fixture);
  return fixture;
}

test('mimir-host refuses a missing store and creates nothing', async () => {
  const fixture = await fixtureOf(false);
  const run = await fixture.run(['tokens']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(`no store at ${fixture.file}`);
  expect(run.stderr).toContain('start the host once');
  expect(existsSync(fixture.file)).toBe(false);
});

test('mimir-host refuses a schema other than its own and leaves the file as it was', async () => {
  const fixture = await fixtureOf();
  await fixture.host.close();
  const database = new Database(fixture.file);
  database.run("insert into schema_version (version, applied_at) values (999, '2099-01-01')");
  database.close();
  const before = readFileSync(fixture.file);

  const run = await fixture.run(['pending']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('the SQLite store schema is version 999');
  expect(readFileSync(fixture.file).equals(before)).toBe(true);
  fixtures.splice(0);
  await fixture.close().catch(() => undefined);
});

test('mimir-host has no store upgrade: the host migrates on boot', async () => {
  const fixture = await fixtureOf();
  const run = await fixture.run(['store', 'upgrade']);
  expect(run.exitCode).toBe(2);
});

test('store export and import carry a board between hosts through standard streams', async () => {
  const source = await fixtureOf();
  const target = await fixtureOf();
  await createProject(source.host.store, { description: null, key: 'MMR', name: 'Mimir' });

  const exported = await source.run(['store', 'export', '-']);
  expect(exported.exitCode).toBe(0);
  const preview = await target.run(['store', 'import', '-'], { stdin: exported.stdout });
  expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false, mode: 'fresh' });
  const applied = await target.run(['store', 'import', '-', '--apply'], {
    stdin: exported.stdout,
  });
  expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, mode: 'fresh' });
  expect((await target.host.store.loadProjects()).map((project) => project.key)).toEqual(['MMR']);

  const refused = await target.run(['store', 'import', '-'], { stdin: '{}' });
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr).toContain('mimir-host store export <file>');
});
