import { describe, expect } from 'vitest';

import { attentionItems } from '../lib/attention';
import { task } from './fixtures';

const staleV = { blocking: false, orphaned: false, stale: true };

describe('attentionItems (MMR-103: under_review + blocked + stale)', () => {
  it('under_review leads, then blocked, then going-cold; ids dedupe across reads', () => {
    const review = task({ id: 'MMR-2', status: 'under_review' });
    const blockedStale = task({ id: 'MMR-4', status: 'blocked', verdicts: staleV });
    const staleReady = task({ id: 'MMR-8', status: 'ready', verdicts: staleV });

    const items = attentionItems(
      [review],
      [blockedStale],
      [blockedStale, staleReady], // blockedStale also surfaced by the stale read — dedupe
    );

    // ordering by "how much your action moves it": review → blocked → going-cold
    expect(items.map((i) => i.node.id)).toStrictEqual(['MMR-2', 'MMR-4', 'MMR-8']);
    expect(items[0]?.reason).toBe('under_review');
    expect(items[1]?.reason).toBe('blocked');
    expect(items[1]?.stale).toBe(true); // kept its blocked reason, flagged stale too
    // a stale-only healthy task surfaces as going cold, not its (healthy) status word
    expect(items[2]?.reason).toBe('going_cold');
    expect(items[2]?.stale).toBe(true);
  });

  it('a stale under_review task shows once — reason under_review, stale rides as a marker', () => {
    const reviewStale = task({ id: 'MMR-3', status: 'under_review', verdicts: staleV });
    const items = attentionItems([reviewStale], [], [reviewStale]);
    expect(items.map((i) => i.node.id)).toStrictEqual(['MMR-3']);
    expect(items[0]?.reason).toBe('under_review');
    expect(items[0]?.stale).toBe(true);
  });

  it('empty when nothing needs attention', () => {
    expect(attentionItems([], [], [])).toStrictEqual([]);
  });
});
