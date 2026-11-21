import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { runArgv } from './testing/run';

/**
 * A verb that takes its text from a flag or from the rest of the line refuses
 * both at once, rather than keeping the flag and dropping the words. Each is a
 * usage error, so no store opens and nothing is written.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

const PAD = '00000000-0000-4000-8000-000000000000';
const GUARD = ['--expected-updated-at', '2026-01-01T00:00:00.000Z'];

test.each([
  [
    ['decline', 'MMR-d1', 'Retry the clone', '--reason', 'Filed', '--', 'extra', 'words'],
    'extra words',
  ],
  [['item', 'drop', 'MMR-3', '1', '--reason', 'Filed', 'extra', 'words'], 'extra words'],
  [['scratch', 'create', '--title', 'T', 'extra', 'words', '-s', 'MMR'], 'extra words'],
  [['scratch', 'agenda', 'supersede', PAD, '1', '--reason', 'R', 'extra', ...GUARD], 'extra'],
  [
    ['scratch', 'agenda', 'complete', PAD, '4', 'because', 'it', 'shipped', ...GUARD],
    'because it shipped',
  ],
])('%j refuses the words it would drop', async (argv, dropped) => {
  const run = await runArgv(board.app(), argv);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain(`unexpected argument: ${dropped}`);
});
