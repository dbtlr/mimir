import { describe, expect } from 'vitest';

import { homeOptions, parentOptions } from '../lib/parent-options';
import { engineTree } from './engine-fixtures';

const tree = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'in_progress', title: 'build', type: 'initiative' }, [
    engineTree({ id: 'MMR-7', status: 'ready', title: 'Phase 5 — UI', type: 'phase' }),
    engineTree({ id: 'MMR-2', status: 'ready', title: 'Phase 0', type: 'phase' }),
  ]),
  engineTree({
    id: 'MMR-9',
    open_ended: true,
    status: 'ready',
    title: 'Polish',
    type: 'initiative',
  }),
]);

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
    const bare = engineTree({ id: 'MMR', status: 'ready', type: 'project' }, [
      engineTree({ id: 'MMR-3', status: 'ready', type: 'task' }),
    ]);
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
