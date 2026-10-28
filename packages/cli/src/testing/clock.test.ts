import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { freezeClock, FROZEN_AT } from './clock';
import { frozenBoard, parityBoard } from './fixture';
import type { ParityBoard } from './fixture';
import { boardSnapshot } from './snapshot';

test('a refused write that leaves a new pad behind fails the untouched-board check', async () => {
  const board = await parityBoard();
  try {
    const before = await boardSnapshot(board, {});
    await board.engine.scratchCreate({ project: 'MMR', title: 'Left behind' });
    const after = await boardSnapshot(board, {});
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

/** Whether the process clock reads the frozen instant. */
const frozen = (): boolean => Date.now() === FROZEN_AT.getTime();

test('a board whose setup throws is closed and the clock thawed before the fault rethrows', async () => {
  let opened: ParityBoard | undefined;
  const fault = new Error('setup failed');
  const failing = frozenBoard((board) => {
    opened = board;
    expect(frozen()).toBe(true);
    return Promise.reject(fault);
  });
  expect(await failing.catch((error: unknown) => error)).toBe(fault);
  expect(frozen()).toBe(false);
  expect(opened !== undefined && existsSync(opened.dir)).toBe(false);
});

test('a board that fails to open thaws the clock before the fault rethrows', async () => {
  const fault = new Error('open failed');
  const failing = frozenBoard(
    () => Promise.resolve(),
    () => Promise.reject(fault),
  );
  expect(await failing.catch((error: unknown) => error)).toBe(fault);
  expect(frozen()).toBe(false);
});

test('closing a frozen board thaws the clock', async () => {
  const open = await frozenBoard(() => Promise.resolve('ready'));
  expect([frozen(), open.value]).toEqual([true, 'ready']);
  await open.close();
  expect([frozen(), existsSync(open.board.dir)]).toEqual([false, false]);
});
