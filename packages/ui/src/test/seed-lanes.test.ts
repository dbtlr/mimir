import { describe, expect, it } from 'vitest';

import {
  SEED_LANE_LABEL,
  SEED_LANE_ORDER,
  groupSeedsByLane,
  isSeedKind,
  seedMatchesQuery,
  seedSummary,
} from '../lib/seed-lanes';
import { seed } from './fixtures';

describe('seed lane grouping (MMR-247)', () => {
  it('orders lanes UNTRIAGED → READY → PROMOTED → SETTLED and drops empties', () => {
    // Deliberately out of order on input.
    const seeds = [
      seed({ id: 'MMR-s4', lane: 'settled', lifecycle: 'resolved' }),
      seed({ id: 'MMR-s2', lane: 'ready', lifecycle: 'promoted' }),
      seed({ id: 'MMR-s1', lane: 'untriaged' }),
      seed({ id: 'MMR-s3', lane: 'promoted', lifecycle: 'promoted' }),
    ];
    const groups = groupSeedsByLane(seeds);
    expect(groups.map((g) => g.lane)).toStrictEqual(SEED_LANE_ORDER);
    expect(groups.map((g) => g.lane)).toStrictEqual(['untriaged', 'ready', 'promoted', 'settled']);
  });

  it('preserves server (FIFO) order within a lane', () => {
    const seeds = [
      seed({ id: 'MMR-s1', lane: 'untriaged' }),
      seed({ id: 'MMR-s2', lane: 'untriaged' }),
    ];
    const [untriaged] = groupSeedsByLane(seeds);
    expect(untriaged?.seeds.map((s) => s.id)).toStrictEqual(['MMR-s1', 'MMR-s2']);
  });

  it('drops a lane with no seeds (no empty header)', () => {
    const groups = groupSeedsByLane([seed({ lane: 'untriaged' })]);
    expect(groups.map((g) => g.lane)).toStrictEqual(['untriaged']);
  });

  it('seedSummary counts untriaged as to-triage and ready as to-resolve', () => {
    const seeds = [
      seed({ lane: 'untriaged' }),
      seed({ lane: 'untriaged' }),
      seed({ lane: 'ready', lifecycle: 'promoted' }),
      seed({ lane: 'promoted', lifecycle: 'promoted' }),
      seed({ lane: 'settled', lifecycle: 'resolved' }),
    ];
    expect(seedSummary(seeds)).toStrictEqual({ toResolve: 1, toTriage: 2 });
  });

  it('labels lanes in sentence case (the group header uppercases them)', () => {
    expect(SEED_LANE_ORDER.map((l) => SEED_LANE_LABEL[l])).toStrictEqual([
      'Untriaged',
      'Ready to resolve',
      'Promoted',
      'Settled',
    ]);
  });

  it('seedMatchesQuery matches id, title, and lede case-insensitively', () => {
    const s = seed({
      id: 'MMR-s7',
      lane: 'untriaged',
      lede: 'Scroll jumps on refetch',
      title: 'Banner Flicker',
    });
    expect(seedMatchesQuery(s, '')).toBe(true);
    expect(seedMatchesQuery(s, 'mmr-S7')).toBe(true);
    expect(seedMatchesQuery(s, 'flicker')).toBe(true);
    expect(seedMatchesQuery(s, 'REFETCH')).toBe(true);
    expect(seedMatchesQuery(s, 'nowhere')).toBe(false);
    expect(seedMatchesQuery(seed({ lane: 'settled', title: 'x' }), 'refetch')).toBe(false);
  });

  it('isSeedKind accepts only the three kinds', () => {
    expect(['idea', 'bug', 'feature'].every((k) => isSeedKind(k))).toBe(true);
    expect(isSeedKind('epic')).toBe(false);
    expect(isSeedKind(undefined)).toBe(false);
  });
});
