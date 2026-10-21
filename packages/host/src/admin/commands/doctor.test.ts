import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createProject } from '@mimir/core';

import { adminFixture } from '../testing';
import type { AdminFixture } from '../testing';

let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await adminFixture();
});
afterEach(async () => fixture.close());

test('doctor reports the record-health facet the console reads', async () => {
  await createProject(fixture.host.store, { description: null, key: 'MMR', name: 'Mimir' });

  const terminal = await fixture.run(['doctor'], { tty: true });
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toBe('[ok] doctor: no problems found\n');

  const piped = await fixture.run(['doctor', '-s', 'MMR']);
  expect(JSON.parse(piped.stdout)).toEqual({
    finding_total: 0,
    groups: [],
    scanned_at: expect.any(String),
    scope: { key: 'MMR', matched_records: 1 },
  });
});

test('doctor reports each finding under its project, and still exits 0', async () => {
  await createProject(fixture.host.store, { description: null, key: 'MMR', name: 'Mimir' });
  const initiative = await createInitiative(fixture.host.store, {
    projectId: 'MMR',
    title: 'Initiative',
  });
  const database = new Database(fixture.file);
  database.run('pragma foreign_keys = off');
  database.run("update node set parent_id = 'MMR-404' where id = ?", [initiative.id]);
  database.close();

  const terminal = await fixture.run(['doctor'], { tty: true });
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toContain('MMR  1 finding');
  expect(terminal.stdout).toMatch(
    new RegExp(`error\\s+${initiative.id}\\s+dangling parent\\s+node/${initiative.id}`),
  );

  const piped = await fixture.run(['doctor']);
  expect(JSON.parse(piped.stdout)).toMatchObject({
    finding_total: 1,
    groups: [{ finding_count: 1, project: 'MMR' }],
  });

  const scoped = await fixture.run(['doctor', '-s', 'NOPE'], { tty: true });
  expect(scoped.exitCode).toBe(0);
  expect(scoped.stderr).toContain("doctor scope 'NOPE' matched 0 records");
});
