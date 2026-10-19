import { describe, expect, it } from 'vitest';

import {
  SEED_LANE_LABEL,
  SEED_LANE_ORDER,
  groupSeedsByLane,
  isSeedKind,
  laneOf,
  seedMatchesQuery,
  seedSummary,
} from '../lib/seed-lanes';
import { seedIn } from './browse-fixtures';

describe('seed lane grouping (MMR-247)', () => {
  it('orders lanes UNTRIAGED → READY → PROMOTED → PARKED → SETTLED and drops empties', () => {
    // Deliberately out of order on input.
    const seeds = [
      seedIn('settled', { id: 'MMR-s4' }),
      seedIn('parked', { id: 'MMR-s5' }),
      seedIn('ready', { id: 'MMR-s2' }),
      seedIn('untriaged', { id: 'MMR-s1' }),
      seedIn('promoted', { id: 'MMR-s3' }),
    ];
    const groups = groupSeedsByLane(seeds);
    expect(groups.map((g) => g.lane)).toStrictEqual(SEED_LANE_ORDER);
    expect(groups.map((g) => g.lane)).toStrictEqual([
      'untriaged',
      'ready',
      'promoted',
      'parked',
      'settled',
    ]);
  });

  it('preserves server (FIFO) order within a lane', () => {
    const seeds = [seedIn('untriaged', { id: 'MMR-s1' }), seedIn('untriaged', { id: 'MMR-s2' })];
    const [untriaged] = groupSeedsByLane(seeds);
    expect(untriaged?.seeds.map((s) => s.id)).toStrictEqual(['MMR-s1', 'MMR-s2']);
  });

  it('drops a lane with no seeds (no empty header)', () => {
    const groups = groupSeedsByLane([seedIn('untriaged')]);
    expect(groups.map((g) => g.lane)).toStrictEqual(['untriaged']);
  });

  it('seedSummary counts untriaged as to-triage and ready as to-resolve', () => {
    const seeds = [
      seedIn('untriaged'),
      seedIn('untriaged'),
      seedIn('ready'),
      seedIn('promoted'),
      seedIn('parked'),
      seedIn('settled'),
    ];
    // A parked seed is set aside on purpose: it never counts as waiting on you.
    expect(seedSummary(seeds)).toStrictEqual({ toResolve: 1, toTriage: 2 });
  });

  it('labels lanes in sentence case (the group header uppercases them)', () => {
    expect(SEED_LANE_ORDER.map((l) => SEED_LANE_LABEL[l])).toStrictEqual([
      'Untriaged',
      'Ready to resolve',
      'Promoted',
      'Parked',
      'Settled',
    ]);
  });

  it('seedMatchesQuery matches id, title, and lede case-insensitively', () => {
    const s = seedIn('untriaged', {
      id: 'MMR-s7',
      lede: 'Scroll jumps on refetch',
      title: 'Banner Flicker',
    });
    expect(seedMatchesQuery(s, '')).toBe(true);
    expect(seedMatchesQuery(s, 'mmr-S7')).toBe(true);
    expect(seedMatchesQuery(s, 'flicker')).toBe(true);
    expect(seedMatchesQuery(s, 'REFETCH')).toBe(true);
    expect(seedMatchesQuery(s, 'nowhere')).toBe(false);
    expect(seedMatchesQuery(seedIn('settled', { title: 'x' }), 'refetch')).toBe(false);
  });

  it('reads the lane of an Engine seed and of an /api wire seed alike', () => {
    expect(laneOf({ lifecycle: 'promoted', readyToResolve: true })).toBe('ready');
    expect(laneOf({ lifecycle: 'promoted', ready_to_resolve: true })).toBe('ready');
    expect(laneOf({ lifecycle: 'promoted', ready_to_resolve: false })).toBe('promoted');
    expect(laneOf({ lifecycle: 'rejected', readyToResolve: true })).toBe('settled');
  });

  it('isSeedKind accepts only the three kinds', () => {
    expect(['idea', 'bug', 'feature'].every((k) => isSeedKind(k))).toBe(true);
    expect(isSeedKind('epic')).toBe(false);
    expect(isSeedKind(undefined)).toBe(false);
  });
});
