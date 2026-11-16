import { describe, expect, test } from 'bun:test';

import type { ChecklistItem } from '@mimir/contract';

import { isCanonicalInstant } from '../time';
import { settledAt } from './intent';

const item = (created_at: string): ChecklistItem => ({
  content: 'x',
  created_at,
  number: 1,
  reason: null,
  settled_at: null,
  state: 'open',
});

describe('settledAt', () => {
  test('never stores text that is not a canonical instant', () => {
    expect(isCanonicalInstant(settledAt(item('banana')))).toBe(true);
    expect(isCanonicalInstant(settledAt(item('2999-01-01T00:00:00.000+05:00')))).toBe(true);
  });

  test('is never earlier than a canonical created_at', () => {
    expect(settledAt(item('2999-01-01T00:00:00.000Z'))).toBe('2999-01-01T00:00:00.000Z');
  });
});
