import { describe, expect } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { buildAncestry } from '../lib/ancestry';

const tree = {
  children: [
    {
      children: [
        {
          children: [{ children: [], id: 'MMR-16', title: 'read-only', type: 'task' }],
          id: 'MMR-7',
          title: 'Phase 5',
          type: 'phase',
        },
        { children: [], id: 'MMR-99', title: 'phaseless task', type: 'task' },
      ],
      id: 'MMR-1',
      title: 'Build',
      type: 'initiative',
    },
  ],
  id: 'MMR',
  title: 'Mimir',
  type: 'project',
} as unknown as WireTreeNode;

describe('buildAncestry', () => {
  it('labels a task with its initiative › phase breadcrumb', () => {
    expect(buildAncestry(tree).get('MMR-16')).toBe('Build › Phase 5');
  });

  it('a task directly under an initiative shows just the initiative', () => {
    expect(buildAncestry(tree).get('MMR-99')).toBe('Build');
  });

  it('the project root is excluded; an initiative has an empty breadcrumb', () => {
    const a = buildAncestry(tree);
    expect(a.get('MMR-1')).toBe('');
    expect(a.get('MMR-7')).toBe('Build');
  });
});
