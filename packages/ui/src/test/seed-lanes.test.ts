import { describe, expect, it } from 'vitest';

import { SEED_LANE_ORDER, groupSeedsByLane, seedSummary, settledCounts } from '../lib/seed-lanes';
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

  it('settledCounts splits resolved vs rejected within the settled lane', () => {
    const settled = [
      seed({ lane: 'settled', lifecycle: 'resolved' }),
      seed({ lane: 'settled', lifecycle: 'resolved' }),
      seed({ lane: 'settled', lifecycle: 'rejected' }),
    ];
    expect(settledCounts(settled)).toStrictEqual({ rejected: 1, resolved: 2 });
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
});
