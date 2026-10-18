import { describe, expect, it } from 'vitest';

import { recordStanding } from '../lib/status';
import { engineNode } from './engine-fixtures';
import { task } from './fixtures';

/*
 * A record's standing reads the same from an /api record and an Engine record
 * while the console's reads move between them (MMR-537).
 */
describe('recordStanding', () => {
  it('dates a done task by its completion, from either read', () => {
    const at = '2026-06-03T15:00:00.000Z';
    expect(recordStanding(task({ completed_at: at, status: 'done' }))).toBe('done 2026-06-03');
    expect(
      recordStanding(engineNode({ completedAt: new Date(at), status: 'done', type: 'task' })),
    ).toBe('done 2026-06-03');
  });

  it('dates an abandoned task by its last change, from either read', () => {
    const at = '2026-06-04T15:00:00.000Z';
    expect(recordStanding(task({ status: 'abandoned', updated_at: at }))).toBe(
      'abandoned 2026-06-04',
    );
    expect(
      recordStanding(engineNode({ status: 'abandoned', type: 'task', updatedAt: new Date(at) })),
    ).toBe('abandoned 2026-06-04');
  });

  it('gives a container or an unsettled task its word alone', () => {
    expect(recordStanding(engineNode({ status: 'done', type: 'phase' }))).toBe('done');
    expect(recordStanding(engineNode({ status: 'ready', type: 'task' }))).toBe('ready');
  });
});
