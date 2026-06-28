import { describe, expect, test } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { parentOptions } from '../lib/parent-options';

const tree = {
  id: 'MMR',
  type: 'project',
  title: 'Mimir',
  children: [
    {
      id: 'MMR-1',
      type: 'initiative',
      title: 'build',
      children: [
        { id: 'MMR-7', type: 'phase', title: 'Phase 5 — UI', children: [] },
        { id: 'MMR-2', type: 'phase', title: 'Phase 0', children: [] },
      ],
    },
  ],
} as unknown as WireTreeNode;

describe('parentOptions', () => {
  it('emits initiatives as selectable group headers with their phases, depth-tagged', () => {
    expect(parentOptions(tree)).toStrictEqual([
      { id: 'MMR-1', label: 'build', depth: 0, type: 'initiative' },
      { id: 'MMR-7', label: 'Phase 5 — UI', depth: 1, type: 'phase' },
      { id: 'MMR-2', label: 'Phase 0', depth: 1, type: 'phase' },
    ]);
  });

  it('skips tasks (never a valid parent) and is empty for a bare project', () => {
    const bare = {
      id: 'MMR',
      type: 'project',
      title: 'M',
      children: [],
    } as unknown as WireTreeNode;
    expect(parentOptions(bare)).toStrictEqual([]);
  });
});
