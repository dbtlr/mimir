import { expect, test } from 'bun:test';

import type { StatusWord } from '@mimir/contract';

import { statusCell } from './node';

test('a status word this build does not know renders instead of throwing', () => {
  // A newer host can send a word an older CLI's style map lacks.
  const unknown = 'landed' as StatusWord;
  expect(statusCell(unknown, 8, true)).toBe('? landed  ');
});
