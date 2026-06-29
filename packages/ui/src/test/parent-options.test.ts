import { describe, expect, test } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { parentOptions } from '../lib/parent-options';

const tree = {
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
  id: 'MMR',
  title: 'Mimir',
  type: 'project',
} as unknown as WireTreeNode;

describe('parentOptions', () => {
  it('emits initiatives as selectable group headers with their phases, depth-tagged', () => {
    expect(parentOptions(tree)).toStrictEqual([
      { depth: 0, id: 'MMR-1', label: 'build', type: 'initiative' },
      { depth: 1, id: 'MMR-7', label: 'Phase 5 — UI', type: 'phase' },
      { depth: 1, id: 'MMR-2', label: 'Phase 0', type: 'phase' },
    ]);
  });

  it('skips tasks (never a valid parent) and is empty for a bare project', () => {
    const bare = {
      children: [],
      id: 'MMR',
      title: 'M',
      type: 'project',
    } as unknown as WireTreeNode;
    expect(parentOptions(bare)).toStrictEqual([]);
  });
});
