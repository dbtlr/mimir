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

const HINT = [
  '',
  '  hint  mimir tree MMR-2   — full subtree',
  '        mimir list --status ready -s MMR   — leaf-actionable tasks',
  '',
].join('\n');

test("a container's records end with its onward hint on a terminal alone", async () => {
  const tty = await runArgv(board.app(), ['get', 'MMR-2'], { tty: true });
  expect(tty.stdout.endsWith(HINT)).toBe(true);
  expect(tty.stdout).toContain('▶ in_progress');
  const piped = await runArgv(board.app(), ['get', 'MMR-2']);
  expect(piped.stdout).not.toContain('hint');
  expect(piped.stdout).toContain('> in_progress');
});

test('get opens no store for a refused column', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone(undefined),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  const outcome = await app.invoke(['get'], { args: { id: 'MMR-3' }, options: { col: ['bogus'] } });
  expect(outcome.status).toBe('failed');
  expect(opened).toBe(false);
});

test('a refusal prints its sentence and its hint on stderr', async () => {
  const run = await runArgv(board.app(), ['get', 'MMR-3', '--col', 'status']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toBe(
    [
      "mimir: --col adds optional columns; 'status' is always shown",
      'optional columns: deps, description, next, annotations, artifacts, history, tags, children, distribution, leafCounts, artifactCount, verdicts, home, lede, content',
      'Run "mimir get --help" to see the usage.',
      '',
    ].join('\n'),
  );
});

test('an artifact reads its body when content is one of several comma-separated columns', async () => {
  const run = await runArgv(board.app(), ['get', 'MMR-a1', '--col', 'tags,content']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain('The body.');
});
