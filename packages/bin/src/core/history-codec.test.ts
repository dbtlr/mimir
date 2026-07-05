import { expect, test } from 'bun:test';

import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import {
  DESCRIPTION_HEADING,
  parseAnnotationsSection,
  parseHistorySection,
  renderAnnotationRecord,
  renderAnnotationsBody,
  renderDescriptionSection,
  renderHistoryRecord,
  renderMigratedNodeBody,
  renderMigratedProjectBody,
  renderNodeBody,
  sliceBodySection,
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

// ── MMR-161: hand-edit hardening (F4 — grammar-anchored record boundaries) ──
// A hand edit can leave an UNESCAPED heading-shaped line inside a record body
// (Mimir's own writes escape these). The split anchors on the record grammar,
// not a bare `### `, so such a line stays content of its record instead of
// splitting one record into two — and shedding the orphaned tail with no error.

test('a hand-typed `### ` line inside a reason stays in the reason (MMR-161 F4)', () => {
  // Raw section text as a hand edit leaves it: the reason carries a bare
  // `### a hand note` line, which lacks the ` — <kind>` tail of a real heading.
  const section =
    '### 2026-07-04T00:00:00.000Z — lifecycle\ntodo → done\nfirst line\n### a hand note\nlast line\n';
  expect(parseHistorySection(section)).toEqual([
    {
      at: '2026-07-04T00:00:00.000Z',
      from: 'todo',
      kind: 'lifecycle',
      reason: 'first line\n### a hand note\nlast line',
      to: 'done',
    },
  ]);
});

test('a hand-typed `### x — y` line with an unknown kind stays in the reason (MMR-161 F4)', () => {
  // A hand edit leaves a heading-SHAPED line (space + em-dash + space) whose
  // kind is not a transition kind. The boundary anchors on the full grammar
  // (shape AND a known kind), so this line must not open a new record and shed
  // the reason tail — it is not a real transition heading.
  const section =
    '### 2026-07-04T00:00:00.000Z — lifecycle\ntodo → done\nstarted\n### follow-up — see comments\ntail\n';
  expect(parseHistorySection(section)).toEqual([
    {
      at: '2026-07-04T00:00:00.000Z',
      from: 'todo',
      kind: 'lifecycle',
      reason: 'started\n### follow-up — see comments\ntail',
      to: 'done',
    },
  ]);
});

test('a hand-typed `### ` line inside an annotation stays in its content (MMR-161 F4)', () => {
  const section = '### 2026-07-04T00:00:00.000Z\nmy note\n### a hand heading\nmore\n';
  expect(parseAnnotationsSection(section)).toEqual([
    { content: 'my note\n### a hand heading\nmore', createdAt: '2026-07-04T00:00:00.000Z' },
  ]);
});

test('two ISO-headed annotations still split into separate records (MMR-161)', () => {
  const section = '### 2026-07-04T00:00:00.000Z\nfirst\n### 2026-07-04T00:01:00.000Z\nsecond\n';
  expect(parseAnnotationsSection(section)).toEqual([
    { content: 'first', createdAt: '2026-07-04T00:00:00.000Z' },
    { content: 'second', createdAt: '2026-07-04T00:01:00.000Z' },
  ]);
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

// ── sliceBodySection (MMR-154) ───────────────────────────────────────────
// The H2-boundary slicer the Norn read path uses to isolate one section from a
// document body (the NRN-102 `.headings` workaround): everything under the
// named `## Heading` up to the next H2 or EOF. H3 records and escaped `\## `
// content lines are NOT boundaries, so a section round-trips through it.

test('slices the named section body between H2 boundaries', () => {
  const body =
    '## Task Description\n\nprose\n\n## History\n### a\nx\n## Annotations\n### b\nnote\n';
  expect(sliceBodySection(body, 'History')).toBe('### a\nx');
  expect(sliceBodySection(body, 'Annotations')).toBe('### b\nnote\n');
});

test('a missing section slices to the empty string (parses to no records)', () => {
  expect(sliceBodySection('## History\n### a\nx\n', 'Annotations')).toBe('');
  expect(parseHistorySection(sliceBodySection('', 'History'))).toEqual([]);
});

test('the H3 records inside a section are not mistaken for a section boundary', () => {
  const body =
    '## History\n### 2026-07-04T00:00:00.000Z — lifecycle\ntodo → done\n## Annotations\n';
  expect(sliceBodySection(body, 'History')).toContain('### 2026-07-04T00:00:00.000Z — lifecycle');
  expect(sliceBodySection(body, 'History')).not.toContain('## Annotations');
});

test('an escaped heading-shaped content line does not close the section', () => {
  const record = renderAnnotationRecord({
    content: '## looks like a boundary\ntail',
    createdAt: '2026-07-04T00:00:00.000Z',
  });
  const body = `## Annotations\n${record}## History\n`;
  // the whole annotation (including its escaped `\## ` line) stays in the slice
  expect(parseAnnotationsSection(sliceBodySection(body, 'Annotations'))).toEqual([
    { content: '## looks like a boundary\ntail', createdAt: '2026-07-04T00:00:00.000Z' },
  ]);
});

test('a description containing a fake `## History` line does not shadow the real section', () => {
  // A node description whose prose contains a literal `## History` (or
  // `## Annotations`) line must not hijack the slicer — the description is
  // escaped so only the real append anchors are section boundaries.
  // Built explicitly (not via string replace, which the escaped `\## History`
  // description line would itself match).
  const description = renderDescriptionSection(
    'see the notes below\n## History\nnot a real heading',
  );
  const body = `## ${DESCRIPTION_HEADING}\n${description}## History\n${renderHistoryRecord(SAMPLES.lifecycle)}## Annotations\n${renderAnnotationRecord(ANNOTATIONS.plain)}`;
  expect(sliceBodySection(body, 'History')).not.toContain('not a real heading');
  expect(parseHistorySection(sliceBodySection(body, 'History'))).toEqual([SAMPLES.lifecycle]);
  expect(parseAnnotationsSection(sliceBodySection(body, 'Annotations'))).toEqual([
    ANNOTATIONS.plain,
  ]);
});

test('a real node body round-trips both sections through slice + parse', () => {
  const history = renderHistoryRecord({
    at: '2026-07-04T00:00:00.000Z',
    from: 'todo',
    kind: 'lifecycle',
    reason: null,
    to: 'in_progress',
  });
  const annotation = renderAnnotationRecord({
    content: 'a note',
    createdAt: '2026-07-04T00:01:00.000Z',
  });
  // a fully-populated node body: seeded shape with records appended under each anchor
  const body = `## Task Description\n\ndesc\n\n## History\n${history}## Annotations\n${annotation}`;
  expect(parseHistorySection(sliceBodySection(body, 'History'))).toHaveLength(1);
  expect(parseAnnotationsSection(sliceBodySection(body, 'Annotations'))).toEqual([
    { content: 'a note', createdAt: '2026-07-04T00:01:00.000Z' },
  ]);
});

// ── Migration body reconstruction (MMR-155) ──────────────────────────────
// The authoritative migration rebuilds a document body from SQLite rows: the
// reconstructed body must read back — through the same slice + parse path the
// Norn reader uses — to the exact records, in order.

test('renderMigratedNodeBody round-trips its history + annotations through the read path', () => {
  const history = Object.values(SAMPLES);
  const annotations = Object.values(ANNOTATIONS);
  const body = renderMigratedNodeBody('the description', history, annotations);
  expect(parseHistorySection(sliceBodySection(body, 'History'))).toEqual(history);
  expect(parseAnnotationsSection(sliceBodySection(body, 'Annotations'))).toEqual(annotations);
});

test('renderMigratedNodeBody with no records equals the empty-seeded node body', () => {
  expect(renderMigratedNodeBody('a task', [], [])).toBe(renderNodeBody('a task'));
});

test('renderMigratedNodeBody escapes a heading-shaped description (no slicer hijack)', () => {
  const body = renderMigratedNodeBody('intro\n## History\ntail', [SAMPLES.lifecycle], []);
  expect(sliceBodySection(body, 'History')).not.toContain('tail');
  expect(parseHistorySection(sliceBodySection(body, 'History'))).toEqual([SAMPLES.lifecycle]);
});

test('renderMigratedProjectBody round-trips a project history (archive transitions)', () => {
  const history = [SAMPLES.archive];
  const body = renderMigratedProjectBody(history);
  expect(parseHistorySection(sliceBodySection(body, 'History'))).toEqual(history);
  // a project body carries History only — no Annotations section
  expect(body).not.toContain(`## Annotations`);
});
