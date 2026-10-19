import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { createApp } from './app';
import { boundClone, parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { runArgv } from './testing/run';

/**
 * Help is generated from the declarations (ADR 0037) and pinned here rather
 * than compared with the old CLI. A deliberate change re-pins its page.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

const page = (name: string): string =>
  readFileSync(new URL(`help-pages/${name}.txt`, import.meta.url), 'utf8');

test.each([
  ['root', ['--help']],
  ['get', ['get', '--help']],
  ['next', ['next', '--help']],
  ['next-compact', ['next', '-h']],
  // MMR-549: the read commands.
  ['list', ['list', '--help']],
  ['projects', ['projects', '--help']],
  ['status', ['status', '--help']],
  ['tree', ['tree', '--help']],
  ['overview', ['overview', '--help']],
  ['artifacts', ['artifacts', '--help']],
  ['search', ['search', '--help']],
  ['seeds', ['seeds', '--help']],
  ['scratch', ['scratch', '--help']],
  ['scratch-list', ['scratch', 'list', '--help']],
  ['scratch-get', ['scratch', 'get', '--help']],
  // MMR-552: the seed verbs, triage, and scratch writes.
  ['seed', ['seed', '--help']],
  ['promote', ['promote', '--help']],
  ['reject', ['reject', '--help']],
  ['resolve', ['resolve', '--help']],
  ['triage', ['triage', '--help']],
  ['scratch-create', ['scratch', 'create', '--help']],
  ['scratch-update', ['scratch', 'update', '--help']],
  ['scratch-checkpoint', ['scratch', 'checkpoint', '--help']],
  ['scratch-agenda', ['scratch', 'agenda', '--help']],
  ['scratch-freeze', ['scratch', 'freeze', '--help']],
  ['scratch-discard', ['scratch', 'discard', '--help']],
])('the %s help page is pinned', async (name, argv) => {
  const run = await runArgv(board.app(), argv);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe(page(name));
});

test('help never opens the store', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone('MMR'),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  await runArgv(app, ['next', '--help']);
  await runArgv(app, ['get', 'MMR-3', '--help']);
  expect(opened).toBe(false);
});
