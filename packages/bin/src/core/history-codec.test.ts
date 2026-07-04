import { expect, test } from 'bun:test';

import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import {
  parseAnnotationsSection,
  parseHistorySection,
  renderAnnotationRecord,
  renderAnnotationsBody,
  renderHistoryRecord,
  renderNodeBody,
} from './history-codec';

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

test('a reason whose line is a markdown heading round-trips (write-path injection guard)', () => {
  // A reason line beginning with `### ` would otherwise be read back as a new
  // transition record, and a `## ` line would close the enclosing ## History
  // section — the codec escapes both on render and recovers them on parse.
  const entry: HistoryEntry = {
    at: '2026-07-03T10:00:00.000Z',
    from: 'in_progress',
    kind: 'lifecycle',
    reason: '### injected heading\n## also injected\nplain tail',
    to: 'under_review',
  };
  const rendered = renderHistoryRecord(entry);
  // the escaped form is not a record delimiter and not a section-closing heading
  expect(rendered).toContain(String.raw`\### injected heading`);
  expect(rendered).toContain(String.raw`\## also injected`);
  // a single record parses back with the exact original reason
  const parsed = parseHistorySection(rendered);
  expect(parsed).toEqual([entry]);
});

test('a benign multi-line reason is untouched by the heading escape', () => {
  const entry: HistoryEntry = {
    at: '2026-07-03T10:00:00.000Z',
    from: 'none',
    kind: 'hold',
    reason: 'blocked on upstream\nsee thread #42 for context',
    to: 'blocked',
  };
  expect(parseHistorySection(renderHistoryRecord(entry))).toEqual([entry]);
});

// F4 — the heading escape must be injective: a reason line that already begins
// with backslash(es) before a heading must not be mistaken for the escape of a
// bare heading, so escape/unescape are exact inverses for ANY reason line.
test.each([
  ['## bare', '## bare'],
  ['# h', '# h'],
  [String.raw`\## note`, String.raw`\## note`],
  [String.raw`\\### x`, String.raw`\\### x`],
  ['###### deep', '###### deep'],
])('round-trips a heading-shaped reason line byte-identically: %j', (_label, reason) => {
  const entry: HistoryEntry = {
    at: '2026-07-03T10:00:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason,
    to: 'done',
  };
  const parsed = parseHistorySection(renderHistoryRecord(entry));
  expect(parsed).toEqual([entry]);
  expect(parsed[0]?.reason).toBe(reason);
});

// F5 — an empty (or whitespace-only) reason must round-trip consistently: the
// parser yields `null` for it, so render must not emit a stray blank reason line.
test('an empty-string reason renders and parses back as null', () => {
  const entry: HistoryEntry = {
    at: '2026-07-03T10:00:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason: '',
    to: 'done',
  };
  const rendered = renderHistoryRecord(entry);
  // no stray blank reason line — byte-identical to a reasonless record
  expect(rendered).toBe('### 2026-07-03T10:00:00.000Z — lifecycle\ntodo → done\n');
  const parsed = parseHistorySection(rendered);
  expect(parsed).toEqual([{ ...entry, reason: null }]);
  expect(parsed[0]?.reason).toBeNull();
});

test('a whitespace-only reason also collapses to null', () => {
  const entry: HistoryEntry = {
    at: '2026-07-03T10:00:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason: '   \n  ',
    to: 'done',
  };
  expect(parseHistorySection(renderHistoryRecord(entry))[0]?.reason).toBeNull();
});

// ── Annotations codec (MMR-154) ──────────────────────────────────────────
// `## Annotations` shares History's H3-per-record shape, minus the edge line:
// the heading carries only the created-at ISO (annotations have no durable id
// and no kind), and the whole body under it is the note content.

const ANNOTATIONS = {
  multiline: {
    content: 'first line\n\nthird line (blank preserved)',
    createdAt: '2026-07-04T09:01:00.000Z',
  },
  plain: {
    content: 'looked into the flake; it is a fixture clock',
    createdAt: '2026-07-04T09:00:00.000Z',
  },
  unicode: {
    content: 'café ☕ — reproduced on arm64\n  sangría preservada',
    createdAt: '2026-07-04T09:02:00.000Z',
  },
} satisfies Record<string, AnnotationView>;

test('an annotation heading carries only the created-at ISO (no kind, no dash)', () => {
  expect(
    renderAnnotationRecord(ANNOTATIONS.plain).startsWith('### 2026-07-04T09:00:00.000Z\n'),
  ).toBe(true);
});

test('an annotation renders its content as the body under the heading', () => {
  expect(renderAnnotationRecord(ANNOTATIONS.plain)).toBe(
    '### 2026-07-04T09:00:00.000Z\nlooked into the flake; it is a fixture clock\n',
  );
});

test.each(Object.entries(ANNOTATIONS))(
  'round-trips a single %s annotation losslessly',
  (_n, view) => {
    expect(parseAnnotationsSection(renderAnnotationRecord(view))).toEqual([view]);
  },
);

test('round-trips a whole annotations section in order', () => {
  const views = Object.values(ANNOTATIONS);
  expect(parseAnnotationsSection(views.map(renderAnnotationRecord).join(''))).toEqual(views);
});

test('round-trips annotations separated by blank lines (reader tolerance)', () => {
  const views = Object.values(ANNOTATIONS);
  expect(parseAnnotationsSection(views.map(renderAnnotationRecord).join('\n'))).toEqual(views);
});

test('an empty annotations section parses to no entries', () => {
  expect(parseAnnotationsSection('')).toEqual([]);
  expect(parseAnnotationsSection(renderAnnotationsBody())).toEqual([]);
});

test('annotation content that is itself a markdown heading round-trips (injection guard)', () => {
  const view: AnnotationView = {
    content: '### looks like a record\n## looks like a section\nplain tail',
    createdAt: '2026-07-04T09:03:00.000Z',
  };
  const rendered = renderAnnotationRecord(view);
  expect(rendered).toContain(String.raw`\### looks like a record`);
  expect(rendered).toContain(String.raw`\## looks like a section`);
  expect(parseAnnotationsSection(rendered)).toEqual([view]);
});

test('the node body seeds an empty ## Annotations section alongside ## History', () => {
  const body = renderNodeBody('a task');
  expect(body).toContain('## History\n');
  expect(body).toContain('## Annotations\n');
  // both append anchors exist and parse empty on a fresh node
  expect(parseHistorySection(body)).toEqual([]);
  expect(parseAnnotationsSection(body)).toEqual([]);
});
