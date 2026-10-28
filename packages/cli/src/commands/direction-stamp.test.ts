import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * Re-authoring the same direction writes nothing, so `updated_at` (which drives
 * the stale predicate) does not move and a no-op never looks like activity. It
 * runs on the real clock, since a frozen one could not tell a write from none.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

test('re-authoring the same direction leaves updated_at where it was', async () => {
  const initiative = await board.engine.create({
    parent: 'MMR',
    title: 'Steady',
    type: 'initiative',
  });
  const phase = await board.engine.create({
    parent: initiative.id,
    title: 'Steady phase',
    type: 'phase',
  });
  const updated = async (): Promise<unknown> => {
    const read = await runArgv(board.app('MMR'), ['get', phase.id, '-f', 'json']);
    return (JSON.parse(read.stdout) as { updated_at: unknown }).updated_at;
  };
  const write = () => runArgv(board.app('MMR'), ['update', phase.id, '--direction', 'Hold.']);
  expect((await write()).exitCode).toBe(0);
  const before = await updated();
  await Bun.sleep(20);
  expect((await write()).exitCode).toBe(0);
  expect(await updated()).toBe(before);
  // The same call with different text does move it, so the check above can fail.
  await Bun.sleep(20);
  expect(
    (await runArgv(board.app('MMR'), ['update', phase.id, '--direction', 'Move on.'])).exitCode,
  ).toBe(0);
  expect(await updated()).not.toBe(before);
});
