import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import { createInitiative, createPhase, createProject, createTask } from '../core';
import type { Store } from '../core';
import { createSqliteTestStore } from '../core/store-sqlite/testing';
import type { SqliteTestStore } from '../core/store-sqlite/testing';
import { nodeIdOf, projectIdOf } from '../testing/store';
import { runCli } from './run';
import { fakeIo } from './testing';

/**
 * A process started before the grooming migration keeps inserting tasks
 * without the column, so a task row can carry NULL grooming (ADR 0033). It
 * must read as `not_groomed` everywhere, never as a missing state.
 */

let fixture: SqliteTestStore;
let store: Store;
let ref: string;
beforeEach(async () => {
  fixture = await createSqliteTestStore();
  store = fixture.store;
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  const task = await createTask(store, {
    parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
    title: 'legacy',
  });
  ref = `MMR-${String(task.seq)}`;
  await fixture.db.updateTable('node').set({ grooming: null }).where('id', '=', ref).execute();
});
afterEach(async () => {
  await fixture.close();
});

test('a task row with NULL grooming reads as not_groomed in rows, filters, and JSON', async () => {
  const rows = fakeIo(false);
  await runCli(['next', '-s', 'MMR'], () => store, rows);
  expect(rows.out.join('')).toMatch(/not_groomed .*legacy/);

  const ids = fakeIo(false);
  await runCli(
    ['next', '-s', 'MMR', '--eq', 'grooming:not_groomed', '-f', 'ids'],
    () => store,
    ids,
  );
  expect(ids.out.join('')).toBe(ref);

  const json = fakeIo(false);
  await runCli(['get', ref, '-f', 'json'], () => store, json);
  expect(parseJson<{ grooming: string }>(json.out.join('')).grooming).toBe('not_groomed');
});
