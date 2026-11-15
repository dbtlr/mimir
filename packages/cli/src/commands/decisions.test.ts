import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
  await board.engine.create({ key: 'OLD', name: 'Archived', type: 'project' });
  await board.engine.archive({ id: 'OLD' });
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
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.stderr).toBe('');
  expect(run.stdout.trim()).toBe(ids.join('\n'));
});

test.each([
  {
    flags: ['--status', 'bad'],
    hint: undefined,
    message: '--status must be provisional, confirmed, overturned, or all',
  },
  {
    flags: ['--class', 'bad'],
    hint: undefined,
    message: '--class must be product, architecture, or other',
  },
  {
    flags: ['--no-linked'],
    hint: undefined,
    message: '--linked takes no false value: omit it to leave links unfiltered',
  },
  ...['MMR-q1', 'MMR-d9', 'OTH-d1'].map((delivery) => ({
    flags: ['--delivery', delivery],
    hint: 'pass a same-project --delivery',
    message: `${delivery} must name a delivery in the same project`,
  })),
  ...['OLD', 'GONE'].map((project) => ({
    flags: ['-p', project],
    hint: `create it: mimir create project "Name" --key ${project} -y`,
    message: `${project} doesn't exist`,
  })),
])('decisions refuses $flags with the full resolution', async ({ flags, message, hint }) => {
  const run = await runArgv(board.app('MMR'), ['decisions', ...flags, '-f', 'json']);
  expect(run.exitCode).not.toBe(0);
  expect(JSON.parse(run.stderr).error).toMatchObject({
    hints: hint === undefined ? ['Run "mimir decisions --help" to see the usage.'] : [hint],
    message,
  });
});

test.each([
  ['decisions', '-p'],
  ['deliveries', '-p'],
  ['artifacts', '-s'],
  ['search', '-s'],
  ['list', '-s'],
  ['next', '-s'],
  ['overview', '-s'],
  ['seeds', '-s'],
  ['scratch', '-s'],
])('%s names its accepted project flag when unbound', async (verb, flag) => {
  const args = [verb];
  if (verb === 'scratch') {
    args.push('list');
  }
  if (verb === 'search') {
    args.push('needle');
  }
  const run = await runArgv(board.app(), [...args, '-f', 'json']);
  expect(run.stderr).toContain(`pass ${flag} KEY, or bind this clone with 'mimir bind KEY'`);
});
