import { describe, expect, test } from 'bun:test';

import { canonicalInstant, isCanonicalInstant, now, parseZonedInstant } from './time';

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

// ── The normalizer ───────────────────────────────────────────────────────────

describe('canonicalInstant normalizes an unambiguously zoned value', () => {
  test.each([
    ['2026-08-05T09:30:00.000Z', '2026-08-05T09:30:00.000Z', 'canonical is its own normal form'],
    ['2026-08-05T09:30:00Z', '2026-08-05T09:30:00.000Z', 'absent milliseconds are filled'],
    ['2026-08-05T09:30Z', '2026-08-05T09:30:00.000Z', 'absent seconds are filled'],
    ['2026-08-05T09:30:00.5Z', '2026-08-05T09:30:00.500Z', 'a short fraction is padded'],
    ['2026-08-05T05:30:00-04:00', '2026-08-05T09:30:00.000Z', 'a negative offset is applied'],
    ['2026-08-05T15:00:00+05:30', '2026-08-05T09:30:00.000Z', 'a half-hour offset is applied'],
    ['2026-08-05T09:30:00+00:00', '2026-08-05T09:30:00.000Z', 'a zero offset becomes Z'],
    ['2026-01-01T00:30:00+02:00', '2025-12-31T22:30:00.000Z', 'an offset may cross the year'],
    // The two STORED-only widenings (MMR-351): both state their instant
    // unambiguously, and both are already storable — norn's `datetime` accepts
    // the space form, and the annotation heading grammar accepts `+0530`.
    ['2026-08-05 09:30:00Z', '2026-08-05T09:30:00.000Z', 'a space separator is a stored variant'],
    ['2026-08-05 05:30:00-04:00', '2026-08-05T09:30:00.000Z', 'a space separator with an offset'],
    [
      '2026-08-05T15:00:00+0530',
      '2026-08-05T09:30:00.000Z',
      'a colon-less offset is a stored variant',
    ],
    ['2026-08-05T09:30-0000', '2026-08-05T09:30:00.000Z', 'a colon-less zero offset'],
  ])('%p → %p (%s)', (value, expected) => {
    expect(canonicalInstant(value)).toBe(expected);
  });

  test('truncates sub-millisecond digits rather than rounding them', () => {
    // Rounding `.9996` up would move an instant PAST values a bound excluded —
    // the same truncation the query grammar applies to caller input.
    expect(canonicalInstant('2026-08-05T09:30:00.9996Z')).toBe('2026-08-05T09:30:00.999Z');
    expect(canonicalInstant('2026-08-05T09:30:00.1239Z')).toBe('2026-08-05T09:30:00.123Z');
  });

  test('normalized values order lexically exactly as they order chronologically', () => {
    const raw = [
      '2026-08-05T15:00:00+05:30', // 09:30Z
      '2026-08-05T09:00:00Z',
      '2026-08-05T05:45:00-04:00', // 09:45Z
    ];
    // The corruption this invariant exists to prevent: the RAW strings sort into
    // the wrong order, the normalized ones into the right one.
    expect(raw.toSorted()).toEqual([
      '2026-08-05T05:45:00-04:00',
      '2026-08-05T09:00:00Z',
      '2026-08-05T15:00:00+05:30',
    ]);
    const normalized = raw.map((value) => canonicalInstant(value) ?? value);
    expect(normalized.toSorted()).toEqual([
      '2026-08-05T09:00:00.000Z',
      '2026-08-05T09:30:00.000Z',
      '2026-08-05T09:45:00.000Z',
    ]);
  });
});

describe('canonicalInstant refuses a value whose instant cannot be inferred', () => {
  test.each([
    ['2026-08-05T09:30:00', 'zone-less — UTC or host-local would be a guess'],
    ['2026-08-05T09:30:00.000', 'zone-less with milliseconds'],
    ['2026-08-05T09:30:00+05', 'an hours-only offset'],
    ['2026-08-05T09Z', 'hours only — minutes are required'],
    ['2026-08-05', 'a bare date carries no time of day'],
    ['2026-08-05Z', 'a bare date with a zone'],
    ['0050-01-01T00:00:00Z', 'a two-digit year Date.UTC would remap into the 1900s'],
    ['2026-02-30T00:00:00Z', 'a day that month never had'],
    ['2026-13-01T00:00:00Z', 'a month that never was'],
    ['2026-08-05T24:00:00Z', 'an out-of-range hour'],
    ['2026-08-05T09:60:00Z', 'an out-of-range minute'],
    ['2026-08-05T09:30:60Z', 'an out-of-range second'],
    ['2026-08-05T09:30:00+24:00', 'an out-of-range offset'],
    ['tuesday', 'prose'],
    ['', 'the empty string'],
    // The widening stops well short of `Date.parse`: these still state no
    // instant a reader could agree on.
    ['2026-08-05 09:30:00', 'a space separator is still no substitute for a zone'],
    ['2026-08-05T09:30:00 +05:30', 'a spaced-off offset'],
    ['2026-08-05T09:30:00+5:30', 'a one-digit offset hour'],
    ['Aug 5 2026 09:30:00 GMT', 'a Date.parse-only spelling'],
    ['2026-08-05T09:30:00Z extra', 'trailing content'],
  ])('%p → null (%s)', (value) => {
    expect(canonicalInstant(value)).toBeNull();
  });

  test('refuses a value whose canonical form would be an EXPANDED year', () => {
    // A large negative offset pushes year 9999 past the range `toISOString`
    // renders in the `YYYY` form; it falls back to `+010000-01-01T…Z`, which is
    // NOT canonical. Emitting it would have repair write a value the next
    // diagnosis calls corrupt — so the normalizer refuses instead.
    expect(canonicalInstant('9999-12-31T23:59:59.999-23:00')).toBeNull();
    // The same instant one day earlier still normalizes: the guard is on the
    // rendered form, not a blanket year ceiling.
    expect(canonicalInstant('9999-12-30T23:59:59.999-23:00')).toBe('9999-12-31T22:59:59.999Z');
  });

  test.each([[null], [undefined], [0], [1_754_386_200_000], [{}], [new Date(0)]])(
    'refuses the non-string %p',
    (value) => {
      expect(canonicalInstant(value)).toBeNull();
    },
  );

  test('a rejected non-leap February 29 stays rejected', () => {
    expect(canonicalInstant('2026-02-29T00:00:00Z')).toBeNull();
    expect(canonicalInstant('2024-02-29T00:00:00Z')).toBe('2024-02-29T00:00:00.000Z');
  });
});

test('parseZonedInstant is the epoch arithmetic behind the normalizer', () => {
  expect(parseZonedInstant('2026-08-05T09:30:00.000Z')).toBe(Date.UTC(2026, 7, 5, 9, 30));
  expect(parseZonedInstant('2026-08-05T05:30:00-04:00')).toBe(Date.UTC(2026, 7, 5, 9, 30));
  expect(parseZonedInstant('2026-08-05T09:30:00')).toBeNull();
});

test('the QUERY grammar stays strict where the STORED grammar widened (MMR-349/351)', () => {
  // The asymmetry is the point: a caller may not TYPE these two spellings — one
  // spelling per instant keeps the query surface teachable — but a document
  // already holding one states its instant, so it is normalized rather than
  // condemned as corruption.
  for (const stored of ['2026-08-05 09:30:00Z', '2026-08-05T15:00:00+0530']) {
    expect(parseZonedInstant(stored)).toBeNull();
    expect(canonicalInstant(stored)).toBe('2026-08-05T09:30:00.000Z');
  }
});
