import { expect, test } from 'bun:test';

import type { WorkNeedsYouRow } from '@mimir/contract';

import { byNeedsYouRowOrder, needsYouId } from './needs-you';

const delivery = (project: string, seq: number, updated_at: string): WorkNeedsYouRow => ({
  delivery: {
    hold_reason: 'Help',
    id: `${project}-d${seq}`,
    lifecycle: 'running',
    phase: `${project}-2`,
    project,
    seq,
    title: 'Stopped',
    updated_at,
  },
  kind: 'delivery',
});
test('recency leads sequence, then lowest sequence leads project key on equal instants', () => {
  const rows = [
    delivery('BBB', 1, '2026-01-01T00:00:00Z'),
    delivery('AAA', 2, '2026-01-01T00:00:00Z'),
    delivery('AAA', 1, '2026-01-01T00:00:00Z'),
    delivery('CCC', 9, '2026-01-02T00:00:00Z'),
  ];
  expect(rows.toSorted(byNeedsYouRowOrder).map(needsYouId)).toEqual([
    'CCC-d9',
    'AAA-d1',
    'BBB-d1',
    'AAA-d2',
  ]);
});

const decision = (seq: number, created_at: string, updated_at: string): WorkNeedsYouRow => ({
  decision: {
    class: 'other',
    created_at,
    delivery: null,
    id: `SET-q${seq}`,
    lifecycle: 'provisional',
    options: ['A', 'B'],
    outcome_note: null,
    overturn_option: null,
    project_key: 'SET',
    question: 'Choose',
    recommended: 1,
    seq,
    taken: 1,
    tasks: [],
    updated_at,
    why: null,
  },
  kind: 'decision',
  workBuiltOnIt: false,
});
test('decision recency uses creation, even when an older decision was updated later', () => {
  const rows = [
    decision(1, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'),
    decision(2, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
  ];
  expect(rows.toSorted(byNeedsYouRowOrder).map(needsYouId)).toEqual(['SET-q2', 'SET-q1']);
});
