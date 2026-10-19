import { afterAll, beforeAll, expect, test } from 'bun:test';

import { createApp } from '../app';
import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

test('an unbound clone with no -s is refused: next reads one project', async () => {
  const outcome = await board.app().invoke(['next'], {});
  expect(outcome.status === 'failed' ? outcome.form : outcome).toEqual({
    code: 'usage',
    exitCode: 2,
    hints: ["pass -s KEY, or bind this clone with 'mimir bind KEY'"],
    message: 'next needs a project',
  });
});

test("'-s all' is retired", async () => {
  const outcome = await board.app('MMR').invoke(['next'], { options: { scope: 'all' } });
  expect(outcome.status === 'failed' ? outcome.form : outcome).toEqual({
    code: 'usage',
    exitCode: 2,
    hints: ["name it with -s KEY; 'mimir projects' lists the keys"],
    message: "'-s all' is retired: next reads one project",
  });
});

test('an unbound clone binds from its origin remote and says so on stderr', async () => {
  const written: [string, string][] = [];
  const app = createApp({
    git: {
      originUrl: () => Promise.resolve('https://github.com/dbtlr/mimir.git'),
      readConfig: () => Promise.resolve(undefined),
      writeConfig: (key, value) => {
        written.push([key, value]);
        return Promise.resolve(true);
      },
    },
    store: () => Promise.resolve(board.store),
  });
  const outcome = await app.invoke(['next'], { options: { format: 'ids' } });
  expect(outcome).toMatchObject({
    messages: 'bound to MMR from the origin remote github.com/dbtlr/mimir (saved in git config)\n',
    output: 'MMR-3\nMMR-8\n',
    status: 'completed',
  });
  expect(written).toEqual([['mimir.project', 'MMR']]);
});

test('a terminal reads icons, color, and the empty-set note; a pipe reads ASCII', async () => {
  const tty = await runArgv(board.app(), ['next', '-s', 'XX', '-p', 'p0'], { tty: true });
  expect(tty.stdout).toBe(
    "0 tasks\n\nNo ready tasks in XX — mimir list --status awaiting -s XX shows what's queued\n",
  );
  const colored = await runArgv(board.app(), ['next', '-s', 'MMR'], { tty: true });
  expect(colored.stdout).toContain('●');
  expect(colored.stdout).toContain('\u001B[');
  const piped = await runArgv(board.app(), ['next', '-s', 'MMR']);
  expect(piped.stdout).toContain('* ready');
  expect(piped.stdout).not.toContain('\u001B[');
});

test('--ascii and NO_COLOR read ASCII on a terminal', async () => {
  const ascii = await runArgv(board.app(), ['next', '-s', 'MMR', '--ascii'], { tty: true });
  expect(ascii.stdout).toContain('* ready');
  expect(ascii.stdout).not.toContain('\u001B[');
  const noColor = await runArgv(board.app(), ['next', '-s', 'MMR'], {
    env: { NO_COLOR: '1', TERM: 'xterm-256color' },
    tty: true,
  });
  expect(noColor.stdout).toContain('* ready');
});

test('a failure under -f json is one JSON line in the failure shape', async () => {
  const run = await runArgv(board.app(), ['next', '-s', 'MMR', '-p', 'zz', '-f', 'json']);
  expect(run.exitCode).toBe(2);
  expect(run.stdout).toBe('');
  expect(JSON.parse(run.stderr)).toEqual({
    error: {
      code: 'usage',
      exitCode: 2,
      hints: ['Run "mimir next --help" to see the usage.'],
      message: 'invalid priority: zz (expected p0|p1|p2|p3)',
    },
  });
});

test('a value warning under -f json is a JSON line on stderr', async () => {
  const run = await runArgv(board.app(), [
    'next',
    '-s',
    'MMR',
    '--eq',
    'priority:p9',
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stderr)).toEqual({
    warning: {
      code: 'no_match_value',
      expected: ['p0', 'p1', 'p2', 'p3'],
      field: 'priority',
      message: 'p9 is not a priority',
      value: 'p9',
    },
  });
});
