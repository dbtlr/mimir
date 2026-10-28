import { afterAll, beforeAll, expect, test } from 'bun:test';

import { createSqliteTestStore } from '@mimir/core/testing';

import { createApp } from '../app';
import { frozenBoard } from '../testing/fixture';
import type { FrozenBoard, ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * Live behaviors the retired binary's suite guarded and no pinned case reaches:
 * the container fallback hint, a
 * pre-migration NULL grooming row, an inherited prerequisite in the human
 * record, and `--tz` deciding which day a stamp falls on.
 */
let frozen: FrozenBoard<undefined>;
let board: ParityBoard;
beforeAll(async () => {
  frozen = await frozenBoard(() => Promise.resolve(undefined));
  board = frozen.board;
});
afterAll(async () => {
  await frozen.close();
});

const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

test('starting a phase with no ready descendants hints at the tree', async () => {
  const initiative = await board.engine.create({
    parent: 'MMR',
    title: 'Hint',
    type: 'initiative',
  });
  const phase = await board.engine.create({
    parent: initiative.id,
    title: 'Done phase',
    type: 'phase',
  });
  const task = await board.engine.create({ parent: phase.id, title: 'Only task', type: 'task' });
  await board.engine.start({ id: task.id });
  await board.engine.done({ id: task.id });
  const run = await runArgv(board.app('MMR'), ['start', phase.id, '-f', 'json']);
  expect(run.exitCode).toBe(1);
  const { error } = json(run.stderr) as { error: { hints: string[] } };
  expect(error.hints.join('\n')).toContain('no ready tasks under it');
  expect(error.hints.join('\n')).toContain(`mimir tree ${phase.id}`);
});

test('a task row with NULL grooming reads as not_groomed in rows, filters, and JSON', async () => {
  const legacy = await createSqliteTestStore();
  try {
    const app = createApp({
      git: {
        originUrl: () => Promise.resolve(undefined),
        readConfig: () => Promise.resolve('MMR'),
        writeConfig: () => Promise.resolve(false),
      },
      store: () => Promise.resolve(legacy.store),
    });
    const { LocalEngine } = await import('@mimir/core');
    const engine = new LocalEngine(legacy.store);
    await engine.create({ key: 'MMR', name: 'm', type: 'project' });
    const initiative = await engine.create({ parent: 'MMR', title: 'i', type: 'initiative' });
    const task = await engine.create({ parent: initiative.id, title: 'legacy', type: 'task' });
    // A process started before the grooming migration keeps inserting tasks without the column.
    await legacy.db.updateTable('node').set({ grooming: null }).where('id', '=', task.id).execute();

    const rows = await runArgv(app, ['next', '-s', 'MMR']);
    expect(rows.stdout).toMatch(/not_groomed .*legacy/);
    const ids = await runArgv(app, [
      'next',
      '-s',
      'MMR',
      '--eq',
      'grooming:not_groomed',
      '-f',
      'ids',
    ]);
    expect(ids.stdout.trim()).toBe(task.id);
    const read = await runArgv(app, ['get', task.id, '-f', 'json']);
    expect(json(read.stdout).grooming).toBe('not_groomed');
  } finally {
    await legacy.close();
  }
});

test('get renders an inherited prerequisite as an "awaiting on ... (via ...)" line', async () => {
  const initiative = await board.engine.create({
    parent: 'MMR',
    title: 'Init',
    type: 'initiative',
  });
  const first = await board.engine.create({ parent: initiative.id, title: 'First', type: 'phase' });
  const second = await board.engine.create({
    parent: initiative.id,
    title: 'Second',
    type: 'phase',
  });
  await board.engine.depend({ id: second.id, on: [first.id] });
  const task = await board.engine.create({ parent: second.id, title: 'work', type: 'task' });
  const run = await runArgv(board.app('MMR'), ['get', task.id], { tty: true });
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.stdout).toContain('awaiting on');
  expect(run.stdout).toContain(`via ${second.id}`);
});

// The board is stamped 2026-10-01T12:00Z: already the 2nd at UTC+14, still the 1st at UTC-11.
test.each([
  ['Pacific/Kiritimati', '2026-10-02', true],
  ['Pacific/Kiritimati', '2026-10-01', false],
  ['Pacific/Niue', '2026-10-01', true],
  ['Pacific/Niue', '2026-10-02', false],
])('--tz %s decides whether created_at:%s matches (%p)', async (zone, day, matches) => {
  const run = await runArgv(board.app('MMR'), [
    'list',
    '-s',
    'MMR',
    '--on',
    `created_at:${day}`,
    '--tz',
    zone,
    '-f',
    'ids',
  ]);
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.stdout.trim() !== '').toBe(matches);
});
