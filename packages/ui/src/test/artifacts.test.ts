import { describe, expect } from 'vitest';

import { groupByRecency, splitKindTags } from '../lib/artifacts';

describe('splitKindTags', () => {
  it('lifts the kind: tag out and keeps the rest as tags', () => {
    expect(splitKindTags(['kind:session', 'doctor'])).toStrictEqual({
      kind: 'session',
      rest: ['doctor'],
    });
  });

  it('no kind: tag → kind undefined, all tags kept', () => {
    expect(splitKindTags(['doctor', 'api'])).toStrictEqual({
      kind: undefined,
      rest: ['doctor', 'api'],
    });
  });

  it('only the first kind: tag is KIND; extras stay tags verbatim', () => {
    expect(splitKindTags(['kind:spec', 'kind:session'])).toStrictEqual({
      kind: 'spec',
      rest: ['kind:session'],
    });
  });

  it('a bare "kind:" prefix with no value is a plain tag', () => {
    expect(splitKindTags(['kind:'])).toStrictEqual({ kind: undefined, rest: ['kind:'] });
  });

  it('empty tags → nothing', () => {
    expect(splitKindTags([])).toStrictEqual({ kind: undefined, rest: [] });
  });
});

const row = (id: string, created: Date) => ({
  created_at: created.toISOString(),
  id,
});

describe('groupByRecency', () => {
  // A fixed "now": Friday 2026-06-19 local — this week starts Mon 06-15.
  const now = new Date(2026, 5, 19, 12, 0, 0).getTime();

  it('buckets THIS WEEK / LAST WEEK / month, preserving input order', () => {
    const groups = groupByRecency(
      [
        row('a', new Date(2026, 5, 18)), // Thu this week
        row('b', new Date(2026, 5, 15)), // Mon this week
        row('c', new Date(2026, 5, 12)), // Fri last week
        row('d', new Date(2026, 4, 28)), // May
        row('e', new Date(2025, 11, 3)), // December, prior year
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toStrictEqual([
      'THIS WEEK',
      'LAST WEEK',
      'MAY 2026',
      'DECEMBER 2025',
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toStrictEqual(['a', 'b']);
    expect(groups[1]?.items.map((i) => i.id)).toStrictEqual(['c']);
  });

  it('marks only THIS WEEK / LAST WEEK as recent (older rows demote)', () => {
    const groups = groupByRecency(
      [
        row('a', new Date(2026, 5, 18)),
        row('c', new Date(2026, 5, 12)),
        row('d', new Date(2026, 4, 28)),
      ],
      now,
    );
    expect(groups.map((g) => g.recent)).toStrictEqual([true, true, false]);
  });

  it('undatable rows land in EARLIER', () => {
    const groups = groupByRecency([{ created_at: 'not-a-date', id: 'x' }], now);
    expect(groups).toStrictEqual([
      { items: [{ created_at: 'not-a-date', id: 'x' }], label: 'EARLIER', recent: false },
    ]);
  });

  it('empty input → no groups', () => {
    expect(groupByRecency([], now)).toStrictEqual([]);
  });
});
