import { describe, expect, it } from 'vitest';

import { newAttempt } from '../lib/t3-attempt';
import { T3_ATTEMPT_PATTERN } from '../server/t3-states';

describe('newAttempt', () => {
  it('makes a distinct id the host accepts', () => {
    const ids = new Set(Array.from({ length: 50 }, newAttempt));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(T3_ATTEMPT_PATTERN);
      expect(id).toHaveLength(22);
    }
  });
});
