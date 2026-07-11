import { describe, expect } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { homeOptions, parentOptions } from '../lib/parent-options';

const tree = {
  children: [
    {
      children: [
        { children: [], id: 'MMR-7', title: 'Phase 5 — UI', type: 'phase' },
        { children: [], id: 'MMR-2', title: 'Phase 0', type: 'phase' },
      ],
      id: 'MMR-1',
      title: 'build',
      type: 'initiative',
    },
    {
      children: [],
      id: 'MMR-9',
      open_ended: true,
      title: 'Polish',
      type: 'initiative',
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
      { depth: 0, id: 'MMR-9', label: 'Polish', type: 'initiative' },
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

describe('homeOptions', () => {
  it('task → every initiative and phase, with the open-ended marker riding along', () => {
    expect(homeOptions('task', tree)).toStrictEqual([
      { depth: 0, id: 'MMR-1', label: 'build', openEnded: false, type: 'initiative' },
      { depth: 1, id: 'MMR-7', label: 'Phase 5 — UI', openEnded: false, type: 'phase' },
      { depth: 1, id: 'MMR-2', label: 'Phase 0', openEnded: false, type: 'phase' },
      { depth: 0, id: 'MMR-9', label: 'Polish', openEnded: true, type: 'initiative' },
    ]);
  });

  it('phase → initiatives only', () => {
    expect(homeOptions('phase', tree)).toStrictEqual([
      { depth: 0, id: 'MMR-1', label: 'build', openEnded: false, type: 'initiative' },
      { depth: 0, id: 'MMR-9', label: 'Polish', openEnded: true, type: 'initiative' },
    ]);
  });

  it('initiative → none within the tree (the project itself is the home)', () => {
    expect(homeOptions('initiative', tree)).toStrictEqual([]);
  });
});
