import { describe, expect, test } from 'bun:test';

import { isCanonicalInstant, now, parseZonedInstant } from './time';

test('now stamps the canonical form', () => {
  expect(isCanonicalInstant(now())).toBe(true);
});

// ── The canonical-form predicate ─────────────────────────────────────────────

describe('isCanonicalInstant', () => {
  test.each([
    ['2026-08-05T09:30:00.000Z', 'the canonical form'],
    ['0100-01-01T00:00:00.000Z', 'the earliest resolvable year'],
    ['2024-02-29T23:59:59.999Z', 'a real leap day'],
  ])('accepts %p — %s', (value) => {
    expect(isCanonicalInstant(value)).toBe(true);
  });

  test.each([
    ['2026-08-05T09:30:00Z', 'no millisecond digits'],
    ['2026-08-05T09:30:00.00Z', 'two fractional digits'],
    ['2026-08-05T09:30:00.000000Z', 'sub-millisecond precision'],
    ['2026-08-05T09:30:00.000+00:00', 'a zero offset instead of Z'],
    ['2026-08-05T05:30:00.000-04:00', 'an offset zone'],
    ['2026-08-05T09:30:00.000', 'no zone at all'],
    ['2026-08-05 09:30:00.000Z', 'a space separator'],
    ['2026-08-05', 'a bare date'],
    ['2026-02-30T00:00:00.000Z', 'the shape of a day that never existed'],
    // Canonical SHAPE, unresolvable ERA: the fast path must apply the same year
    // bound the normalizer does, or one era reads healthy in the millisecond
    // spelling and uninterpretable in every other.
    ['0050-01-01T00:00:00.000Z', 'a year below the resolvable floor'],
    ['0099-12-31T23:59:59.999Z', 'the last instant below the floor'],
    ['not-a-time', 'garbage'],
    ['', 'the empty string'],
  ])('rejects %p — %s', (value) => {
    expect(isCanonicalInstant(value)).toBe(false);
  });

  test.each([[null], [undefined], [0], [1_754_386_200_000], [{}], [['2026-08-05T09:30:00.000Z']]])(
    'rejects the non-string %p',
    (value) => {
      expect(isCanonicalInstant(value)).toBe(false);
    },
  );
});

test('parseZonedInstant is the zoned-instant epoch arithmetic', () => {
  expect(parseZonedInstant('2026-08-05T09:30:00.000Z')).toBe(Date.UTC(2026, 7, 5, 9, 30));
  expect(parseZonedInstant('2026-08-05T05:30:00-04:00')).toBe(Date.UTC(2026, 7, 5, 9, 30));
  expect(parseZonedInstant('2026-08-05T09:30:00')).toBeNull();
  // One spelling per instant: the colon-less offset and the space separator are refused.
  expect(parseZonedInstant('2026-08-05T15:00:00+0530')).toBeNull();
  expect(parseZonedInstant('2026-08-05 09:30:00Z')).toBeNull();
});
