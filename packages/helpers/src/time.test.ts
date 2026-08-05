import { describe, expect, test } from 'bun:test';

import { ago, formatDay, formatInstant, relativeTime } from './time';

// A fixed instant per case; the zone is always explicit, so these assertions
// hold on any machine regardless of its own TZ.
describe('formatInstant', () => {
  test('renders UTC with a UTC label', () => {
    expect(formatInstant('2026-08-05T13:14:00.000Z', 'UTC')).toBe('2026-08-05 13:14 UTC');
  });

  test('renders the caller zone wall clock, not the UTC one', () => {
    expect(formatInstant('2026-08-05T13:14:00.000Z', 'America/New_York')).toBe(
      '2026-08-05 09:14 EDT',
    );
  });

  test('the label follows the zone across a DST boundary', () => {
    expect(formatInstant('2026-01-15T13:14:00.000Z', 'America/New_York')).toBe(
      '2026-01-15 08:14 EST',
    );
    expect(formatInstant('2026-07-15T13:14:00.000Z', 'America/New_York')).toBe(
      '2026-07-15 09:14 EDT',
    );
  });

  test('a half-hour zone with no abbreviation labels with its GMT offset', () => {
    expect(formatInstant('2026-08-05T13:14:00.000Z', 'Asia/Kolkata')).toBe(
      '2026-08-05 18:44 GMT+5:30',
    );
  });

  test('midnight reads 00:00, never 24:00', () => {
    expect(formatInstant('2026-08-05T04:00:00.000Z', 'America/New_York')).toBe(
      '2026-08-05 00:00 EDT',
    );
  });

  test('an unreadable instant renders the placeholder, never a raw value', () => {
    expect(formatInstant('not-a-date', 'UTC')).toBe('—');
  });

  test('an out-of-range epoch renders the placeholder rather than throwing', () => {
    expect(formatInstant(1e20, 'UTC')).toBe('—');
    expect(formatInstant(Number.POSITIVE_INFINITY, 'UTC')).toBe('—');
    expect(formatInstant(Number.NEGATIVE_INFINITY, 'UTC')).toBe('—');
  });

  test('a three-digit year is zero-padded to the YYYY-MM-DD shape', () => {
    expect(formatInstant(Date.parse('0999-06-01T12:00:00.000Z'), 'UTC')).toBe(
      '0999-06-01 12:00 UTC',
    );
  });
});

describe('formatDay', () => {
  test('is the local calendar day, which can differ from the UTC one', () => {
    expect(formatDay('2026-08-05T02:00:00.000Z', 'UTC')).toBe('2026-08-05');
    expect(formatDay('2026-08-05T02:00:00.000Z', 'America/New_York')).toBe('2026-08-04');
    expect(formatDay('2026-08-05T20:00:00.000Z', 'Asia/Kolkata')).toBe('2026-08-06');
  });

  test('an unreadable instant renders the placeholder', () => {
    expect(formatDay('', 'UTC')).toBe('—');
    expect(formatDay(1e20, 'UTC')).toBe('—');
  });

  test('keeps the four-digit shape shortDate slices', () => {
    const day = formatDay(Date.parse('0999-06-01T12:00:00.000Z'), 'UTC');
    expect(day).toBe('0999-06-01');
    expect(day.slice(5)).toBe('06-01');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const before = (ms: number): string => relativeTime(now - ms, now);

  test('walks the unit ladder', () => {
    expect(before(30_000)).toBe('now');
    expect(before(4 * 60_000)).toBe('4m');
    expect(before(3 * 3_600_000)).toBe('3h');
    expect(before(6 * 86_400_000)).toBe('6d');
    expect(before(56 * 86_400_000)).toBe('8w');
  });

  test('days give way to weeks at a fortnight', () => {
    expect(before(13 * 86_400_000)).toBe('13d');
    expect(before(14 * 86_400_000)).toBe('2w');
  });

  test('weeks give way to months, and months to years', () => {
    expect(before(59 * 86_400_000)).toBe('8w');
    expect(before(60 * 86_400_000)).toBe('2mo');
    expect(before(300 * 86_400_000)).toBe('10mo');
    expect(before(364 * 86_400_000)).toBe('12mo');
    expect(before(365 * 86_400_000)).toBe('1y');
    expect(before(10 * 365 * 86_400_000)).toBe('10y');
  });

  test('a future instant never reads negative', () => {
    expect(relativeTime(now + 86_400_000, now)).toBe('now');
  });

  test('an unreadable now renders the placeholder, never "NaNw"', () => {
    expect(relativeTime(now - 86_400_000, Number.NaN)).toBe('—');
    expect(relativeTime(now - 86_400_000, Number.POSITIVE_INFINITY)).toBe('—');
  });

  test('accepts an ISO string as well as an epoch value', () => {
    expect(relativeTime('2026-08-05T09:00:00.000Z', now)).toBe('3h');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');

  test('phrases the ladder', () => {
    expect(ago(now - 30_000, now)).toBe('just now');
    expect(ago(now - 4 * 60_000, now)).toBe('4m ago');
    expect(ago(now - 3 * 365 * 86_400_000, now)).toBe('3y ago');
  });

  test('an unreadable now phrases the placeholder', () => {
    expect(ago(now - 4 * 60_000, Number.NaN)).toBe('— ago');
  });
});
