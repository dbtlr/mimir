import { expect, test } from 'bun:test';

import { UsageError } from './errors';
import { parseSize } from './parse';

test('parseSize accepts the full size words', () => {
  expect(parseSize('small')).toBe('small');
  expect(parseSize('medium')).toBe('medium');
  expect(parseSize('large')).toBe('large');
});

test('parseSize accepts any unambiguous prefix, case-insensitively', () => {
  // the help row already advertises `--size <s|m|l>` — honor it
  expect(parseSize('s')).toBe('small');
  expect(parseSize('m')).toBe('medium');
  expect(parseSize('l')).toBe('large');
  expect(parseSize('med')).toBe('medium');
  expect(parseSize('M')).toBe('medium');
});

test('parseSize passes undefined through (flag absent)', () => {
  expect(parseSize(undefined)).toBeUndefined();
});

test('parseSize rejects a non-prefix value with the expected-values hint', () => {
  let err: unknown;
  try {
    parseSize('x');
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain('invalid size: x');
});

test('parseSize rejects the empty string (an ambiguous prefix, not a value)', () => {
  expect(() => parseSize('')).toThrow(UsageError);
});
