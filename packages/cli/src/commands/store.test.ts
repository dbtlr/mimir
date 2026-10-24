import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

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

/** DEL and C1 controls, among them a CSI introducer and a control-string start that would swallow what follows. */
const TITLE = 'a\u0085b\u009Bxyz123m tail\u0090 kept \u007F end';

test.each(['json', 'jsonl', 'records', 'ids', 'table'])(
  'store export - prints a document whose data survives terminal controls (%s)',
  async (format) => {
    const created = await runArgv(board.app(), [
      'create',
      'task',
      TITLE,
      '--parent',
      'MMR-2',
      '-f',
      'ids',
    ]);
    expect(created.exitCode).toBe(0);
    const id = created.stdout.trim();
    const run = await runArgv(board.app(), ['store', 'export', '-', '-f', format]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toMatch(/[\u007F-\u009F]/u);
    const document = parseJson<{ nodes: { id: string; title: string }[] }>(run.stdout);
    expect(document.nodes.find((node) => node.id === id)?.title).toBe(TITLE);
  },
);
