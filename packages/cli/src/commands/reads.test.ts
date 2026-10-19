/**
 * The behavior of the read commands that has no old-CLI counterpart to compare
 * with: the `-s all` and unbound refusals, compact jsonl documents, and the MCP
 * opt-in each command declares.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { createApp } from '../app';
import { boundClone, parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

const BOARD_READS = [
  ['list'],
  ['overview'],
  ['artifacts'],
  ['search', 'store'],
  ['seeds'],
  ['scratch', 'list'],
];

test.each(BOARD_READS)('%s refuses -s all: only projects spans projects', async (...argv) => {
  const run = await runArgv(board.app(), [...argv, '-s', 'all']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain("'-s all' is retired");
});

test.each(BOARD_READS)('%s refuses an unbound clone with no project', async (...argv) => {
  const run = await runArgv(board.app(), argv);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('needs a project');
  expect(run.stderr).toContain('pass -s KEY, or bind this clone');
});

test('projects spans every project whatever the clone binds', async () => {
  const run = await runArgv(board.app('MMR'), ['projects', '-f', 'ids']);
  expect(run.stdout).toBe('MMR\nXX\n');
});

test('status and overview print one compact document under jsonl, not the whole value', async () => {
  const status = await runArgv(board.app(), ['status', 'MMR-3', '-f', 'jsonl']);
  expect(status.stdout).toBe('{"distribution":{},"id":"MMR-3","status":"ready"}\n');
  const overview = await runArgv(board.app(), ['overview', '-s', 'MMR', '-f', 'jsonl']);
  expect(overview.stdout.trimEnd().split('\n')).toHaveLength(1);
  expect(overview.stdout).not.toContain('presentation');
});

test('overview renders records on a terminal and json when piped', async () => {
  const piped = await runArgv(board.app(), ['overview', '-s', 'MMR']);
  expect(piped.stdout.startsWith('{')).toBe(true);
  const tty = await runArgv(board.app(), ['overview', '-s', 'MMR'], { tty: true });
  expect(tty.stdout).toContain('hygiene');
});

test('status defaults to json on a terminal too', async () => {
  const tty = await runArgv(board.app(), ['status', 'MMR-3'], { tty: true });
  expect(tty.stdout.startsWith('{')).toBe(true);
});

test('every read opts in to MCP as read-only', () => {
  const root = board.app().inspect().root;
  const READS = ['list', 'projects', 'status', 'tree', 'overview', 'artifacts', 'search', 'seeds'];
  for (const name of READS) {
    const node = root.children.find((child) => child.name === name);
    expect(JSON.stringify(node?.extensions)).toContain('readOnly');
  }
  const scratch = root.children.find((child) => child.name === 'scratch');
  const names = scratch?.children.map((child) => child.name) ?? [];
  expect(names).toContain('get');
  expect(names).toContain('list');
  for (const child of scratch?.children ?? []) {
    if (child.name === 'get' || child.name === 'list') {
      expect(JSON.stringify(child.extensions)).toContain('readOnly');
    }
  }
});

test('a wrong invocation opens no store', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone('MMR'),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  for (const argv of [
    ['list', '--status', 'bogus'],
    ['artifacts', '--offset', '2x'],
    ['search', 'x', '-n', '0'],
    ['seeds', '--sort', 'sideways'],
    ['projects', '--status', 'bogus'],
  ]) {
    const run = await runArgv(app, argv);
    expect(run.exitCode).toBe(2);
  }
  expect(opened).toBe(false);
});
