import { expect, test } from 'bun:test';

import { collapse } from './decode';

// ── collapse (MMR-152, aliased decode MMR-190) ────────────────────────────────
// `collapse` narrows a frontmatter wikilink (or bare stem) to its canonical stem.
// A `[[STEM|alias]]` display link keeps the STEM and drops the alias, so a
// relational ref resolves through the normal valid/dangling path (MMR-190).

test('an aliased wikilink keeps the stem and drops the |alias segment (MMR-190)', () => {
  expect(collapse('[[MMR-2|Some Title]]')).toBe('MMR-2');
});

test('an aliased wikilink trims whitespace around the stem (MMR-190)', () => {
  expect(collapse('[[MMR-2 | Some Title]]')).toBe('MMR-2');
});

test('an alias containing further pipes is dropped whole — only the stem survives', () => {
  expect(collapse('[[MMR-2|Title | Subtitle]]')).toBe('MMR-2');
});

test('a bare wikilink is unchanged — the stem is returned verbatim', () => {
  expect(collapse('[[MMR-2]]')).toBe('MMR-2');
});

test('a plain (non-wikilink) stem is returned verbatim', () => {
  expect(collapse('MMR-2')).toBe('MMR-2');
});

test('a non-wikilink string is preserved verbatim — no split, no trim', () => {
  // A pipe or surrounding whitespace only matters INSIDE `[[ ]]`; a bare string is
  // never a display link, so it passes through untouched.
  expect(collapse('a|b')).toBe('a|b');
  expect(collapse(' MMR-2 ')).toBe(' MMR-2 ');
});

test('an empty wikilink is unusable → null', () => {
  expect(collapse('[[]]')).toBeNull();
});

test('an alias-only wikilink (empty stem) is unusable → null', () => {
  expect(collapse('[[|alias]]')).toBeNull();
});

test('the empty string is unusable → null', () => {
  expect(collapse('')).toBeNull();
});

test('a non-string is unusable → null', () => {
  expect(collapse(null)).toBeNull();
  expect(collapse(undefined)).toBeNull();
  expect(collapse(42)).toBeNull();
  expect(collapse(['[[MMR-2]]'])).toBeNull();
});
