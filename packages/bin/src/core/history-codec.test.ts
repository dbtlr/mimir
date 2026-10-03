import { expect, test } from 'bun:test';

import { flattenHandle, HANDLE_SEP, isEchoSafeHandle, toCanonicalLf } from './history-codec';

test('toCanonicalLf turns CRLF line endings into LF and leaves LF alone', () => {
  expect(toCanonicalLf('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  expect(toCanonicalLf('one\ntwo')).toBe('one\ntwo');
});

test('flattenHandle collapses newlines, whitespace runs, and the separator to one line', () => {
  expect(flattenHandle('  feat/x\n  next line ')).toBe('feat/x next line');
  expect(flattenHandle(`a${HANDLE_SEP}b`)).toBe('a b');
});

test('flattenHandle is idempotent', () => {
  const once = flattenHandle(`a\n\n${HANDLE_SEP} b`);
  expect(flattenHandle(once)).toBe(once);
});

test('a handle is echo-safe exactly when flattening changes nothing', () => {
  expect(isEchoSafeHandle('feat/x')).toBe(true);
  expect(isEchoSafeHandle('feat/x\nmore')).toBe(false);
  expect(isEchoSafeHandle(`a${HANDLE_SEP}b`)).toBe(false);
  expect(isEchoSafeHandle(' padded')).toBe(false);
});
