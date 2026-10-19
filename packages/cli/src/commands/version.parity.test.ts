import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { VERSION } from '../version';

/**
 * The old binary answers `version` before its CLI runs, so the harness cannot
 * run it: the contract is the bare version on stdout, whatever the format.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

test.each([
  [[]],
  [['-f', 'ids']],
  [['-f', 'table']],
  [['-f', 'records']],
  [['-f', 'json']],
  [['-f', 'jsonl']],
])('version %p prints the bare version', async (flags) => {
  const run = await runArgv(board.app(), ['version', ...flags]);
  expect(run).toEqual({ exitCode: 0, stderr: '', stdout: `${VERSION}\n` });
});

test('the Application reports the stamped version', async () => {
  expect(board.app().inspect().version).toBe(VERSION);
});

// The old binary's `--version` flag alias is a documented difference (see version.ts).
test('--version is an unknown option, not a flag alias', async () => {
  const run = await runArgv(board.app(), ['--version']);
  expect(run.exitCode).toBe(2);
});

test('version prints the same on a terminal', async () => {
  const run = await runArgv(board.app(), ['version'], { tty: true });
  expect(run.stdout).toBe(`${VERSION}\n`);
});

test('version never opens the store', async () => {
  const { createApp } = await import('../app');
  const app = createApp({
    git: {
      originUrl: () => Promise.resolve(undefined),
      readConfig: () => Promise.resolve(undefined),
      writeConfig: () => Promise.resolve(false),
    },
    store: () => Promise.reject(new Error('the store is not read')),
  });
  expect((await runArgv(app, ['version'])).stdout).toBe(`${VERSION}\n`);
});
