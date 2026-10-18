import { describe, expect, it } from 'vitest';

import { buildFeed } from '../lib/timeline';
import type { HistoryEntry } from '../lib/timeline';

const started: HistoryEntry = {
  at: new Date('2026-06-02T09:00:00.000Z'),
  from: 'todo',
  kind: 'lifecycle',
  reason: null,
  to: 'in_progress',
};
const parked: HistoryEntry = {
  at: new Date('2026-06-04T09:00:00.000Z'),
  from: 'none',
  kind: 'hold',
  reason: 'waiting on Saga',
  to: 'parked',
};

describe('buildFeed', () => {
  it('merges the creation anchor, transitions, and notes oldest-first', () => {
    const feed = buildFeed(
      new Date('2026-06-01T10:00:00.000Z'),
      [parked, started],
      [{ content: 'looked into the facet', createdAt: new Date('2026-06-03T09:00:00.000Z') }],
    );

    expect(feed.map((item) => item.variant)).toStrictEqual([
      'created',
      'transition',
      'annotation',
      'transition',
    ]);
    expect(feed.map((item) => item.at.toISOString())).toStrictEqual([
      '2026-06-01T10:00:00.000Z',
      '2026-06-02T09:00:00.000Z',
      '2026-06-03T09:00:00.000Z',
      '2026-06-04T09:00:00.000Z',
    ]);
  });

  it('is just the creation anchor when there is no history or notes', () => {
    const createdAt = new Date('2026-06-01T10:00:00.000Z');
    expect(buildFeed(createdAt, undefined, undefined)).toStrictEqual([
      { at: createdAt, sort: createdAt.getTime(), variant: 'created' },
    ]);
  });
});
