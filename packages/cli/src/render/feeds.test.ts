import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
  await board.engine.create({ key: 'WD', name: 'wide', type: 'project' });
  for (const title of ['端末幅の表示メモ', 'Plain notes']) {
    await board.engine.attach({ content: 'body', project: 'WD', tags: ['design'], title });
  }
});
afterAll(async () => {
  await board.close();
});

test('the artifact feed aligns wide-character titles by terminal cell', async () => {
  const run = await runArgv(board.app('WD'), ['artifacts'], { tty: true });
  const rows = run.stdout.split('\n').filter((line) => line.startsWith('WD-a'));
  expect(rows).toHaveLength(2);
  const tagCells = rows.map((line) => Bun.stringWidth(line.slice(0, line.indexOf('design'))));
  expect(new Set(tagCells).size).toBe(1);
});
