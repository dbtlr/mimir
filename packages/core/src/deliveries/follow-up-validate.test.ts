import { expect, test } from 'bun:test';

import type { DeliveryFollowUpRecord } from '@mimir/contract';

import { followUpFaults } from './follow-up-validate';

const linked: DeliveryFollowUpRecord = {
  delivery: 'VAL-d1',
  linked_at: '2026-11-16T00:00:00.000Z',
  seed: null,
  task: 'VAL-1',
  unlinked_at: null,
};
const deliveries = new Map([['VAL-d1', 'VAL']]);
const nodes = new Map([
  ['VAL-1', { project_id: 'VAL', type: 'task' }],
  ['VAL-2', { project_id: 'VAL', type: 'phase' }],
  ['OTH-1', { project_id: 'OTH', type: 'task' }],
]);
const seeds = new Set(['OTH-s1']);
const cases: [string, Partial<DeliveryFollowUpRecord>][] = [
  ['delivery is missing', { delivery: 'VAL-d99' }],
  ['exactly one', { seed: 'OTH-s1' }],
  ['exactly one', { task: null }],
  ['task is missing', { task: 'VAL-99' }],
  ['not a task', { task: 'VAL-2' }],
  ['another project', { task: 'OTH-1' }],
  ['seed is missing', { seed: 'OTH-s99', task: null }],
  ['linked_at is not', { linked_at: '2026-11-16T00:00:00Z' }],
  ['unlinked_at is not', { unlinked_at: '2026-11-17' }],
  ['earlier', { unlinked_at: '2026-11-15T00:00:00.000Z' }],
];
test.each(cases)('transfer and doctor refuse %s (%j)', (message, patch) => {
  expect(
    followUpFaults([{ ...linked, ...patch }], deliveries, nodes, seeds).some((fault) =>
      fault.message.includes(message),
    ),
  ).toBe(true);
});
test('transfer and doctor refuse two standing rows but accept retained unlinks', () => {
  expect(
    followUpFaults([linked, linked], deliveries, nodes, seeds).map((fault) => fault.message),
  ).toEqual(['duplicate standing link']);
  expect(
    followUpFaults(
      [{ ...linked, unlinked_at: linked.linked_at }, linked],
      deliveries,
      nodes,
      seeds,
    ),
  ).toEqual([]);
});
