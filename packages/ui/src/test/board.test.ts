import { describe, expect, test } from 'vitest';

import { BOARD_COLUMNS, buildBoard } from '../lib/board';
import { NOW, daysAgo, task } from './fixtures';

describe('bOARD_COLUMNS', () => {
  it('reads left→right as a pipeline toward Done', () => {
    expect(BOARD_COLUMNS).toStrictEqual([
      'parked',
      'blocked',
      'awaiting',
      'ready',
      'in_progress',
      'under_review',
      'done',
    ]);
  });
});

describe('buildBoard', () => {
  it('buckets by status word — columns are the status vocabulary', () => {
    const live = [
      task({ id: 'MMR-1', status: 'in_progress' }),
      task({ id: 'MMR-2', status: 'ready' }),
      task({ id: 'MMR-3', status: 'awaiting' }),
      task({ id: 'MMR-4', status: 'blocked' }),
      task({ id: 'MMR-5', status: 'parked' }),
    ];
    const board = buildBoard(live, [], NOW);
    expect(board.in_progress.map((n) => n.id)).toStrictEqual(['MMR-1']);
    expect(board.ready.map((n) => n.id)).toStrictEqual(['MMR-2']);
    expect(board.awaiting.map((n) => n.id)).toStrictEqual(['MMR-3']);
    expect(board.blocked.map((n) => n.id)).toStrictEqual(['MMR-4']);
    expect(board.parked.map((n) => n.id)).toStrictEqual(['MMR-5']);
  });

  it('ready preserves API array order — array order IS rank', () => {
    const live = [
      task({ id: 'MMR-9', status: 'ready' }),
      task({ id: 'MMR-2', status: 'in_progress' }),
      task({ id: 'MMR-7', status: 'ready' }),
      task({ id: 'MMR-31', status: 'ready' }),
    ];
    const board = buildBoard(live, [], NOW);
    expect(board.ready.map((n) => n.id)).toStrictEqual(['MMR-9', 'MMR-7', 'MMR-31']);
  });

  it('done is windowed to the last 7 days of completions', () => {
    const done = [
      task({ id: 'MMR-50', status: 'done', completed_at: daysAgo(1) }),
      task({ id: 'MMR-51', status: 'done', completed_at: daysAgo(6) }),
      task({ id: 'MMR-52', status: 'done', completed_at: daysAgo(8) }),
      task({ id: 'MMR-53', status: 'done', completed_at: null }),
    ];
    const board = buildBoard([], done, NOW);
    expect(board.done.map((n) => n.id)).toStrictEqual(['MMR-50', 'MMR-51']);
  });

  it('abandoned and new are never columns', () => {
    const live = [
      task({ id: 'MMR-60', status: 'abandoned' }),
      task({ id: 'MMR-61', status: 'new' }),
      task({ id: 'MMR-62', status: 'ready' }),
    ];
    const board = buildBoard(live, [], NOW);
    const placed = Object.values(board).flat();
    expect(placed.map((n) => n.id)).toStrictEqual(['MMR-62']);
  });
});
