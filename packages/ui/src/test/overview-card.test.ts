import { describe, expect, it } from 'vitest';

import { overviewCardCounts } from '../lib/overview-card';

describe('overviewCardCounts (MMR-226)', () => {
  it('maps the leaf facet to live/ready/review and folds held', () => {
    const rows = overviewCardCounts({
      awaiting: 5,
      blocked: 2,
      in_progress: 3,
      parked: 7,
      ready: 4,
      under_review: 1,
    });
    expect(rows.map((r) => [r.key, r.count])).toStrictEqual([
      ['live', 3],
      ['ready', 4],
      ['review', 1],
      ['held', 14], // 5 awaiting + 2 blocked + 7 parked
    ]);
  });

  it('drops zero-count rows', () => {
    const rows = overviewCardCounts({ in_progress: 2 });
    expect(rows.map((r) => r.key)).toStrictEqual(['live']);
  });

  it('returns nothing when the facet is absent', () => {
    expect(overviewCardCounts(undefined)).toStrictEqual([]);
  });
});
