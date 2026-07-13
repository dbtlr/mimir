import { describe, expect } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { buildBands } from '../lib/bands';
import { buildBoard } from '../lib/board';
import { NOW, task } from './fixtures';

/**
 * A three-tier tree: an initiative with a phase and a directly-attached task,
 * plus a second, open-ended initiative. Only the fields the band grouping reads
 * (id/title/type/open_ended/distribution/children) are set.
 */
const tree = {
  children: [
    {
      children: [
        {
          children: [{ children: [], id: 'MMR-10', title: 'phased task', type: 'task' }],
          distribution: { ready: 1 },
          id: 'MMR-2',
          title: 'Phase A',
          type: 'phase',
        },
        { children: [], id: 'MMR-11', title: 'loose task', type: 'task' },
      ],
      id: 'MMR-1',
      title: 'Build',
      type: 'initiative',
    },
    {
      children: [{ children: [], id: 'MMR-12', title: 'intake', type: 'task' }],
      id: 'MMR-3',
      open_ended: true,
      title: 'Feeds',
      type: 'initiative',
    },
  ],
  id: 'MMR',
  title: 'Mimir',
  type: 'project',
} as unknown as WireTreeNode;

const live = [
  task({ id: 'MMR-10', status: 'ready' }),
  task({ id: 'MMR-11', status: 'in_progress' }),
  task({ id: 'MMR-12', status: 'under_review' }),
];

describe('buildBands — phase mode', () => {
  it('bands a leaf on its nearest phase, else its initiative', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'phase', tree);
    const byName = new Map(bands.map((b) => [b.name, b]));
    expect(byName.get('Phase A')?.columns.ready.map((n) => n.id)).toStrictEqual(['MMR-10']);
    // MMR-11 sits directly under the initiative — the initiative is its band.
    expect(byName.get('Build')?.columns.in_progress.map((n) => n.id)).toStrictEqual(['MMR-11']);
  });

  it('orders bands by the tree pre-order, not encounter order', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'phase', tree);
    expect(bands.map((b) => b.name)).toStrictEqual(['Build', 'Phase A', 'Feeds']);
  });

  it('carries the container rollup for the mini bar, computing it when absent', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'phase', tree);
    const byName = new Map(bands.map((b) => [b.name, b]));
    // Phase A supplies its own rollup distribution…
    expect(byName.get('Phase A')?.distribution).toStrictEqual({ ready: 1 });
    // …Build has none on the node, so it's tallied from the band's own leaves.
    expect(byName.get('Build')?.distribution).toStrictEqual({ in_progress: 1 });
  });

  it('flags an open-ended container', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'phase', tree);
    const feeds = bands.find((b) => b.name === 'Feeds');
    expect(feeds?.openEnded).toBe(true);
    expect(bands.find((b) => b.name === 'Build')?.openEnded).toBe(false);
  });

  it('falls back to the single flat band when no tree is available', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'phase', undefined);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.name).toBe('');
    expect(bands[0]?.columns.ready.map((n) => n.id)).toStrictEqual(['MMR-10']);
  });
});

describe('buildBands — release mode', () => {
  const relLive = [
    task({
      id: 'MMR-20',
      status: 'ready',
      tags: [{ created_at: '', tag: 'release:v0.13' }],
    }),
    task({
      id: 'MMR-21',
      status: 'in_progress',
      tags: [{ created_at: '', tag: 'release:v0.13' }],
    }),
    task({
      id: 'MMR-22',
      status: 'ready',
      tags: [{ created_at: '', tag: 'release:v0.14' }],
    }),
    task({ id: 'MMR-23', status: 'ready' }),
  ];

  it('groups by the release tag with an untagged bucket trailing last', () => {
    const bands = buildBands(buildBoard(relLive, [], NOW), 'release', tree);
    expect(bands.map((b) => b.name)).toStrictEqual(['v0.13', 'v0.14', 'No release']);
    expect(bands[0]?.columns.ready.map((n) => n.id)).toStrictEqual(['MMR-20']);
    expect(bands[0]?.columns.in_progress.map((n) => n.id)).toStrictEqual(['MMR-21']);
    expect(bands[2]?.columns.ready.map((n) => n.id)).toStrictEqual(['MMR-23']);
  });

  it('computes a release band distribution from its own leaves', () => {
    const bands = buildBands(buildBoard(relLive, [], NOW), 'release', tree);
    expect(bands[0]?.distribution).toStrictEqual({ in_progress: 1, ready: 1 });
  });

  it('mutes only the trailing untagged bucket, not the tagged bands', () => {
    const bands = buildBands(buildBoard(relLive, [], NOW), 'release', tree);
    expect(bands.find((b) => b.name === 'v0.13')?.muted).toBeUndefined();
    expect(bands.find((b) => b.name === 'No release')?.muted).toBe(true);
  });

  it('omits the untagged bucket when every leaf is tagged', () => {
    const tagged = [
      task({
        id: 'MMR-24',
        status: 'ready',
        tags: [{ created_at: '', tag: 'release:v1' }],
      }),
    ];
    const bands = buildBands(buildBoard(tagged, [], NOW), 'release', tree);
    expect(bands.map((b) => b.name)).toStrictEqual(['v1']);
  });
});

describe('buildBands — off mode', () => {
  it('flattens to a single spineless band regardless of the tree', () => {
    const bands = buildBands(buildBoard(live, [], NOW), 'off', tree);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.name).toBe('');
    expect(bands[0]?.columns.under_review.map((n) => n.id)).toStrictEqual(['MMR-12']);
  });
});
