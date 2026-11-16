import { expect, test } from 'bun:test';

import { liveDeliveriesOf, recentJournal } from './delivery-page';

const row = (id: string, phase: string, lifecycle: string) => ({ id, lifecycle, phase });

test('live deliveries drop landed and abandoned ones and other phases', () => {
  const rows = [
    row('d1', 'P1', 'agreed'),
    row('d2', 'P1', 'running'),
    row('d3', 'P1', 'landed'),
    row('d4', 'P1', 'abandoned'),
    row('d5', 'P2', 'running'),
  ];
  expect(liveDeliveriesOf(rows, 'P1').map((d) => d.id)).toEqual(['d1', 'd2']);
});

test('the journal tail is the five newest entries, newest first', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((n) => `Entry ${String(n)}`);
  expect(recentJournal(entries)).toEqual(['Entry 7', 'Entry 6', 'Entry 5', 'Entry 4', 'Entry 3']);
  expect(recentJournal(['only'])).toEqual(['only']);
});
