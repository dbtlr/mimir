import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../lib/timeline';
import { verdictSummary } from '../lib/verdict';

const submit = (at: string): HistoryEntry => ({
  at: new Date(at),
  from: 'in_progress',
  kind: 'lifecycle',
  reason: null,
  to: 'under_review',
});

describe('verdictSummary (MMR-262)', () => {
  it('is the latest annotation at or after the most recent submit', () => {
    const summary = verdictSummary(
      [submit('2026-06-05T09:00:00.000Z'), submit('2026-06-07T09:00:00.000Z')],
      [
        { content: 'first round notes', createdAt: new Date('2026-06-05T10:00:00.000Z') },
        { content: 'second round, early', createdAt: new Date('2026-06-07T09:00:00.000Z') },
        { content: 'second round, final', createdAt: new Date('2026-06-07T11:00:00.000Z') },
      ],
    );
    expect(summary).toBe('second round, final');
  });

  it('ignores annotations written before the submit', () => {
    const summary = verdictSummary(
      [submit('2026-06-05T09:00:00.000Z')],
      [{ content: 'working notes', createdAt: new Date('2026-06-04T09:00:00.000Z') }],
    );
    expect(summary).toBeUndefined();
  });

  it('is undefined without a submit transition, however many notes exist', () => {
    expect(
      verdictSummary([], [{ content: 'a note', createdAt: new Date('2026-06-05T09:00:00.000Z') }]),
    ).toBeUndefined();
    expect(verdictSummary(undefined, undefined)).toBeUndefined();
  });
});
