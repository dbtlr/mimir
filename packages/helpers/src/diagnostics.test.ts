import { expect, test } from 'bun:test';

import { describeFault, formatDiagnostic } from './diagnostics';

const LINE_SEPARATOR = String.fromCodePoint(0x20_28);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x20_29);

test('describeFault stringifies a thrown value that is not an Error', () => {
  expect(describeFault('boom')).toEqual({ message: 'boom' });
  expect(describeFault(42)).toEqual({ message: '42' });
  expect(describeFault(undefined)).toEqual({ message: 'undefined' });
});

test('describeFault keeps the message apart from a stack that omits it', () => {
  // A Zod v4 failure's stack is just its name, while the message names the fields.
  const error = new Error('path children.0.createdAt: Invalid ISO datetime');
  error.stack = 'ZodError';
  expect(describeFault(error)).toEqual({ message: error.message, stack: 'ZodError' });
});

test('describeFault omits the stack when the error has none', () => {
  const error = new Error('no stack');
  error.stack = undefined;
  expect(describeFault(error)).toEqual({ message: 'no stack' });
});

test('formatDiagnostic escapes U+2028 and U+2029 so a diagnostic stays on one line', () => {
  const line = formatDiagnostic({
    ok: true,
    path: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`,
  });
  expect(line).not.toContain(LINE_SEPARATOR);
  expect(line).not.toContain(PARAGRAPH_SEPARATOR);
  expect(line).toContain(String.raw`a b c`);
  expect(line).not.toContain('\n');
});
