import { expect, test } from 'bun:test';

import type { Presentation } from './presentation';
import { renderScratchpad, renderScratchRows } from './scratch';

/**
 * How a Scratchpad reads on the styled formats (MMR-350, ADR 0029): display
 * instants render in the reader's zone, `updated_at` stays the byte-exact
 * concurrency token a mutation's `--expected-updated-at` echoes back, and a
 * staged freeze is marked in the list.
 */
const eastern: Presentation = { isTTY: false, plain: true, zone: 'America/New_York' };
const kiritimati: Presentation = { isTTY: false, plain: true, zone: 'Pacific/Kiritimati' };

const wire = {
  created_at: '2026-08-05T13:14:00.000Z',
  freezing_at: null,
  id: 'pad-1',
  journal: [{ at: '2026-08-05T13:20:00.000Z', content: 'note', number: 1 }],
  updated_at: '2026-08-05T13:20:00.000Z',
};

test('creation and Journal stamps read in the reader zone, with its label', () => {
  const text = renderScratchpad(wire, eastern);
  expect(text).toContain('created at  2026-08-05 09:14 EDT');
  expect(text).toContain('2026-08-05 09:20 EDT');
});

test('a non-UTC zone moves the day, not just the hour', () => {
  expect(renderScratchpad(wire, kiritimati)).toContain('created at  2026-08-06 03:14');
});

test('updated_at stays the canonical UTC token, whatever the zone', () => {
  for (const zone of [eastern, kiritimati]) {
    const text = renderScratchpad(wire, zone);
    expect(/^updated at {2}(.+)$/m.exec(text)?.[1]).toBe('2026-08-05T13:20:00.000Z');
    // Nothing else prints as a raw instant.
    expect(text.replace(/^updated at .*$/m, '')).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  }
});

test('a staged freeze is marked in the list, and a staged freezing_at localizes', () => {
  const rows = renderScratchRows([
    {
      id: 'pad-1',
      project: 'MMR',
      state: 'freezing',
      title: 'Staged',
      updated_at: '2026-08-03T00:00:00.000Z',
    },
    {
      id: 'pad-2',
      project: 'MMR',
      state: 'active',
      title: 'Open',
      updated_at: '2026-08-03T00:00:00.000Z',
    },
  ]).split('\n');
  expect(rows[0]).toStartWith('freezing  pad-1');
  expect(rows[1]).toStartWith('pad-2');
  expect(renderScratchpad({ ...wire, freezing_at: '2026-08-05T13:30:00.000Z' }, eastern)).toContain(
    'freezing at  2026-08-05 09:30 EDT',
  );
});
