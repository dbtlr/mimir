import { expect, test } from 'bun:test';

import { freezeClock, FROZEN_AT } from './clock';
import { parityBoard } from './fixture';
import { boardSnapshot } from './snapshot';

test('a refused write that leaves a new pad behind fails the untouched-board check', async () => {
  const board = await parityBoard();
  try {
    const before = await boardSnapshot(board, {}, ['{}']);
    await board.engine.scratchCreate({ project: 'MMR', title: 'Left behind' });
    const after = await boardSnapshot(board, {}, ['{}']);
    expect(after).not.toBe(before);
  } finally {
    await board.close();
  }
});

test('the frozen clock freezes only the zero-argument forms of Date', () => {
  freezeClock(true);
  try {
    expect(new Date().getTime()).toBe(FROZEN_AT.getTime());
    expect(Date.now()).toBe(FROZEN_AT.getTime());
    const local = new Date(2026, 9, 1);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(9);
    expect(local.getDate()).toBe(1);
    expect(new Date('2020-01-02T03:04:05.000Z').getTime()).toBe(Date.UTC(2020, 0, 2, 3, 4, 5));
  } finally {
    freezeClock(false);
  }
});
