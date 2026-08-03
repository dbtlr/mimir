import { expect, test } from 'bun:test';

import { decodeScratchpadBody, encodeScratchpadBody, lintScratchpadValue } from './codec';

test('a canonical Scratchpad body round-trips both owned sections', () => {
  const body = {
    agenda: [
      {
        content: 'Settle the persistence boundary',
        number: 1,
        reason: null,
        state: 'open' as const,
      },
      {
        content: 'Try the old shape',
        number: 2,
        reason: 'store owns no policy',
        state: 'superseded' as const,
      },
      { content: 'Record the decision', number: 3, reason: null, state: 'done' as const },
    ],
    journal: [
      {
        at: '2026-08-03T12:34:56.789Z',
        content: 'The codec is the shared read and diagnosis boundary.',
        number: 1,
      },
    ],
  };

  const encoded = encodeScratchpadBody(body);

  expect(encoded).toBe(
    '## Journal\n\n### 1 — 2026-08-03T12:34:56.789Z\n\nThe codec is the shared read and diagnosis boundary.\n\n' +
      '## Agenda\n\n1. [ ] Settle the persistence boundary\n' +
      '2. [-] Try the old shape — reason: store owns no policy\n' +
      '3. [x] Record the decision\n',
  );
  expect(decodeScratchpadBody(encoded)).toEqual({ problems: [], value: body });
});

test('structural corruption quarantines the whole Scratchpad with typed findings', () => {
  const decoded = decodeScratchpadBody(
    '## Journal\n\n### 2 — 2026-08-03T12:34:56Z\n\nEntry\n\n## Agenda\n\n1. [-] Old plan\n2. [ ] Still useful\n\n## Agenda\n',
  );

  expect(decoded.value).toBeNull();
  expect(decoded.problems.map(({ problem }) => problem)).toEqual(['duplicate-agenda-section']);
});

test('record corruption is reported together and quarantines the whole Scratchpad', () => {
  const decoded = decodeScratchpadBody(
    '## Journal\n\n### 2 — 2026-08-03T12:34:56Z\n\nEntry\n\n## Agenda\n\n1. [-] Old plan\n3. [ ] Still useful\n',
  );

  expect(decoded.value).toBeNull();
  expect(decoded.problems.map(({ problem }) => problem)).toEqual([
    'journal-sequence',
    'invalid-journal-timestamp',
    'superseded-reason-required',
    'agenda-sequence',
  ]);
});

test('Journal numbering, not wall-clock order, defines entry order', () => {
  const decoded = decodeScratchpadBody(
    '## Journal\n\n### 1 — 2026-08-03T13:00:00.000Z\n\nFirst\n\n### 2 — 2026-08-03T12:00:00.000Z\n\nSecond\n\n## Agenda\n',
  );

  expect(decoded.problems).toEqual([]);
  expect(decoded.value?.journal.map(({ number }) => number)).toEqual([1, 2]);
});

test('unowned prose in the Journal section is corruption, not silently discarded', () => {
  const decoded = decodeScratchpadBody(
    '## Journal\n\nloose preamble\n\n### 1 — 2026-08-03T12:00:00.000Z\n\nEntry\n\n## Agenda\n',
  );

  expect(decoded.value).toBeNull();
  expect(decoded.problems.map(({ problem }) => problem)).toEqual(['malformed-journal-entry']);
});

test('Journal Markdown round-trips fenced headings and literal heading escapes', () => {
  const content = [
    'A code sample:',
    '',
    '```md',
    '## Agenda',
    '### 99 — not-an-entry',
    '```',
    '',
    String.raw`\## deliberately escaped`,
    '### a real prose subheading',
  ].join('\n');
  const value = {
    agenda: [],
    journal: [{ at: '2026-08-03T12:00:00.000Z', content, number: 1 }],
  };

  expect(decodeScratchpadBody(encodeScratchpadBody(value))).toEqual({ problems: [], value });
});

test('Agenda reasons match the superseded state without lossy coercion', () => {
  expect(
    lintScratchpadValue({
      agenda: [{ content: 'Old', number: 1, reason: null, state: 'superseded' }],
      journal: [],
    }),
  ).toEqual(['agenda 1 requires a supersession reason']);
  expect(
    lintScratchpadValue({
      agenda: [{ content: 'Open', number: 1, reason: 'not applicable', state: 'open' }],
      journal: [],
    }),
  ).toEqual(['agenda 1 carries a reason outside superseded state']);
});
