import { describe, expect } from 'vitest';

import { RANKABLE_COLUMNS, columnIds, dropToReorder } from '../components/board';
import { buildBoard } from '../lib/board';
import { task } from './fixtures';

describe('board drag wiring', () => {
  it('rankable columns are exactly the non-terminal, un-held ones', () => {
    expect(RANKABLE_COLUMNS).toStrictEqual(['in_progress', 'ready', 'awaiting']);
  });

  it('columnIds reads the ordered ids of a column', () => {
    const board = buildBoard(
      [task({ id: 'MMR-1', status: 'ready' }), task({ id: 'MMR-2', status: 'ready' })],
      [],
    );
    expect(columnIds(board, 'ready')).toStrictEqual(['MMR-1', 'MMR-2']);
  });

  it('dropToReorder turns a drop into reorder args', () => {
    const ordered = ['MMR-1', 'MMR-2', 'MMR-3'];
    expect(dropToReorder('MMR-1', 'MMR-3', ordered)).toStrictEqual({ after: 'MMR-3' });
    expect(dropToReorder('MMR-3', 'MMR-1', ordered)).toStrictEqual({ before: 'MMR-1' });
    expect(dropToReorder('MMR-2', 'MMR-2', ordered)).toBeNull();
  });
});
