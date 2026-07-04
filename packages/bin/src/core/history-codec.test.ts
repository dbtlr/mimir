import { expect, test } from 'bun:test';

import type { HistoryEntry } from '@mimir/contract';

import { parseHistorySection, renderHistoryRecord } from './history-codec';

/** A representative entry per shape the transition log emits (ADR 0003). */
const SAMPLES = {
  archive: {
    at: '2026-07-03T10:00:00.000Z',
    from: 'active',
    kind: 'archive',
    reason: null,
    to: 'archived',
  },
  dependencyAdd: {
    at: '2026-07-03T10:01:00.000Z',
    from: null,
    kind: 'dependency',
    reason: null,
    to: 'MMR-130',
  },
  dependencyRemove: {
    at: '2026-07-03T10:02:00.000Z',
    from: 'MMR-4',
    kind: 'dependency',
    reason: 'no longer a prerequisite',
    to: null,
  },
  holdReason: {
    at: '2026-07-03T10:03:00.000Z',
    from: 'none',
    kind: 'hold',
    reason: 'waiting on the API',
    to: 'blocked',
  },
  holdRelease: {
    at: '2026-07-03T10:04:00.000Z',
    from: 'parked',
    kind: 'hold',
    reason: null,
    to: 'none',
  },
  lifecycle: {
    at: '2026-07-03T10:05:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason: null,
    to: 'in_progress',
  },
  lifecycleReason: {
    at: '2026-07-03T10:06:00.000Z',
    from: 'in_progress',
    kind: 'lifecycle',
    reason: 'shipped',
    to: 'done',
  },
  moveRooted: {
    at: '2026-07-03T10:07:00.000Z',
    from: null,
    kind: 'move',
    reason: null,
    to: 'MMR-2',
  },
  moveSubtree: {
    at: '2026-07-03T10:08:00.000Z',
    from: 'MMR-1',
    kind: 'move',
    reason: null,
    to: 'MMR-9',
  },
  unicodeReason: {
    at: '2026-07-03T10:09:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason: 'primera línea 🎉\nsegunda línea\n  sangría preservada',
    to: 'abandoned',
  },
} satisfies Record<string, HistoryEntry>;

test('the heading carries the ISO timestamp and kind separated by an em dash', () => {
  const block = renderHistoryRecord(SAMPLES.lifecycle);
  expect(block.startsWith('### 2026-07-03T10:05:00.000Z — lifecycle\n')).toBe(true);
});

test('a two-sided transition renders as `from → to`', () => {
  expect(renderHistoryRecord(SAMPLES.lifecycle)).toContain('todo → in_progress');
});

test('an added edge (from is null) renders as `+to`', () => {
  expect(renderHistoryRecord(SAMPLES.dependencyAdd)).toContain('+MMR-130');
});

test('a removed edge (to is null) renders as `-from`', () => {
  expect(renderHistoryRecord(SAMPLES.dependencyRemove)).toContain('-MMR-4');
});

test('a reason rides its own line under the transition', () => {
  const block = renderHistoryRecord(SAMPLES.lifecycleReason);
  expect(block).toBe('### 2026-07-03T10:06:00.000Z — lifecycle\nin_progress → done\nshipped\n');
});

test('a reasonless record has no trailing reason line', () => {
  const block = renderHistoryRecord(SAMPLES.lifecycle);
  expect(block).toBe('### 2026-07-03T10:05:00.000Z — lifecycle\ntodo → in_progress\n');
});

test.each(Object.entries(SAMPLES))('round-trips a single %s record losslessly', (_name, entry) => {
  expect(parseHistorySection(renderHistoryRecord(entry))).toEqual([entry]);
});

test('round-trips a whole section of concatenated records in order', () => {
  const entries = Object.values(SAMPLES);
  const section = entries.map(renderHistoryRecord).join('');
  expect(parseHistorySection(section)).toEqual(entries);
});

test('round-trips records separated by blank lines (reader tolerance)', () => {
  const entries = Object.values(SAMPLES);
  const section = entries.map(renderHistoryRecord).join('\n');
  expect(parseHistorySection(section)).toEqual(entries);
});

test('ignores non-record content around the records', () => {
  const section = `some preamble\n\n${renderHistoryRecord(SAMPLES.holdReason)}`;
  expect(parseHistorySection(section)).toEqual([SAMPLES.holdReason]);
});

test('an empty section parses to no entries', () => {
  expect(parseHistorySection('')).toEqual([]);
});

test('skips an H3 whose kind is not a known transition kind', () => {
  const section = '### 2026-07-03T10:00:00.000Z — nonsense\ntodo → done\n';
  expect(parseHistorySection(section)).toEqual([]);
});
