import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
  await board.engine.deliveryCreate({ phase: 'MMR-2', title: 'Attempt' });
  const base = { options: ['Here', 'There'], project: 'MMR', question: 'Where?', recommended: 1 };
  await board.engine.decide({ ...base, class: 'product', delivery: 'MMR-d1', tasks: ['MMR-3'] });
  await board.engine.decide({ ...base, class: 'architecture' });
  const d = await board.engine.decide({ ...base, class: 'other' });
  await board.engine.confirm({ id: d.id });
});
afterAll(async () => {
  await board.close();
});

test.each([
  { flags: [], ids: ['MMR-q1', 'MMR-q2'] },
  { flags: ['--status', 'confirmed'], ids: ['MMR-q3'] },
  { flags: ['--status', 'overturned'], ids: [] },
  { flags: ['--status', 'all'], ids: ['MMR-q1', 'MMR-q2', 'MMR-q3'] },
  { flags: ['--class', 'product', '--class', 'architecture'], ids: ['MMR-q1', 'MMR-q2'] },
  { flags: ['--class', 'product', '--class', 'architecture', '--linked'], ids: ['MMR-q1'] },
  { flags: ['--delivery', 'MMR-d1'], ids: ['MMR-q1'] },
])('decisions parses $flags and uses the clone binding', async ({ flags, ids }) => {
  const run = await runArgv(board.app('MMR'), ['decisions', ...flags, '-f', 'ids']);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe('');
  expect(run.stdout.trim()).toBe(ids.join('\n'));
});

test.each([
  ['--status', 'bad'],
  ['--class', 'bad'],
  ['--delivery', 'MMR-q1'],
])('decisions refuses invalid %s %s', async (flag, value) => {
  const run = await runArgv(board.app('MMR'), ['decisions', flag, value]);
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain(flag === '--delivery' ? 'delivery id' : flag);
});
