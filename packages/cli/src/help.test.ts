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
