import { describe, expect, test } from 'bun:test';

import {
  dateFilterWindow,
  dateFilterWindows,
  intersectWindows,
  isTimeZone,
  parseDateFilterTokens,
  systemTimeZone,
  withinWindow,
} from './dates';
import { expectMimirError } from './testing';

/** The window edges as their canonical instants — the assertion subject throughout. */
const edges = (op: Parameters<typeof dateFilterWindow>[0], value: string, zone?: string) => {
  const window = dateFilterWindow(op, value, zone);
  return { from: window.from?.at ?? null, until: window.until?.at ?? null };
};

describe('timezone validation', () => {
  test('accepts IANA names and the aliases the canonical list omits', () => {
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('Australia/Lord_Howe')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
  });

  test('rejects non-zones, including bare UTC offsets', () => {
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('+05:00')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  test('the system zone is itself a valid zone', () => {
    expect(isTimeZone(systemTimeZone())).toBe(true);
  });
});

describe('bare dates resolve through the caller zone', () => {
  test('a plain day opens and closes at the caller-local midnight', () => {
    expect(edges('on', '2026-06-10', 'America/New_York')).toEqual({
      from: '2026-06-10T04:00:00.000Z',
      until: '2026-06-11T04:00:00.000Z',
    });
    expect(edges('on', '2026-06-10', 'UTC')).toEqual({
      from: '2026-06-10T00:00:00.000Z',
      until: '2026-06-11T00:00:00.000Z',
    });
  });

  test('spring forward makes a 23-hour day, fall back a 25-hour one', () => {
    const spring = dateFilterWindow('on', '2026-03-08', 'America/New_York');
    expect(spring.from?.at).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.until?.at).toBe('2026-03-09T04:00:00.000Z');
    expect((spring.until?.epochMs ?? 0) - (spring.from?.epochMs ?? 0)).toBe(23 * 60 * 60 * 1000);

    const fall = dateFilterWindow('on', '2026-11-01', 'America/New_York');
    expect(fall.from?.at).toBe('2026-11-01T04:00:00.000Z');
    expect(fall.until?.at).toBe('2026-11-02T05:00:00.000Z');
    expect((fall.until?.epochMs ?? 0) - (fall.from?.epochMs ?? 0)).toBe(25 * 60 * 60 * 1000);
  });

  test('a non-hour offset zone resolves on its half hour', () => {
    // Kathmandu is UTC+05:45 year-round.
    expect(edges('on', '2026-06-10', 'Asia/Kathmandu')).toEqual({
      from: '2026-06-09T18:15:00.000Z',
      until: '2026-06-10T18:15:00.000Z',
    });
    // Lord Howe is +10:30 in winter and +11:00 over its half-hour DST.
    expect(edges('on', '2026-06-10', 'Australia/Lord_Howe')).toEqual({
      from: '2026-06-09T13:30:00.000Z',
      until: '2026-06-10T13:30:00.000Z',
    });
  });

  // A fall-back that lands ON or just after midnight makes the day's first hour
  // happen twice, and the day opens at the FIRST of them. East of Greenwich the
  // naive two-guess resolution reads only the post-transition offset and picks
  // the later midnight, quietly shortening a 25-hour day to 24 and filing that
  // hour's rows under the wrong day. Every expectation below is an instant
  // computed independently of this module (a minute-by-minute scan over Intl's
  // `longOffset` readings), not a value the module produced.
  test.each([
    ['Asia/Amman', '2021-10-29', '2021-10-28T21:00:00.000Z', '2021-10-29T22:00:00.000Z', 25],
    ['Asia/Gaza', '2021-10-29', '2021-10-28T21:00:00.000Z', '2021-10-29T22:00:00.000Z', 25],
    ['Asia/Magadan', '2014-10-26', '2014-10-25T12:00:00.000Z', '2014-10-26T14:00:00.000Z', 26],
    ['Antarctica/Casey', '2023-03-09', '2023-03-08T13:00:00.000Z', '2023-03-09T16:00:00.000Z', 27],
    ['Asia/Colombo', '1996-05-25', '1996-05-24T18:30:00.000Z', '1996-05-25T17:30:00.000Z', 23],
  ])('%s %s opens at the earlier of a repeated midnight', (zone, day, from, until, hours) => {
    const window = dateFilterWindow('on', day, zone);
    expect({ from: window.from?.at, until: window.until?.at }).toEqual({ from, until });
    expect((window.until?.epochMs ?? 0) - (window.from?.epochMs ?? 0)).toBe(hours * 60 * 60 * 1000);
  });

  test('a day that never happened is an empty window', () => {
    // Samoa skipped 2011-12-30 entirely when it crossed the date line.
    expect(edges('on', '2011-12-30', 'Pacific/Apia')).toEqual({
      from: '2011-12-30T10:00:00.000Z',
      until: '2011-12-30T10:00:00.000Z',
    });
    expect(
      withinWindow(
        dateFilterWindow('on', '2011-12-30', 'Pacific/Apia'),
        '2011-12-30T10:00:00.000Z',
      ),
    ).toBe(false);
  });

  test('a day whose local midnight does not exist opens at its first real instant', () => {
    // Chile springs forward AT midnight: 2026-09-06 has no 00:00 local.
    const window = dateFilterWindow('on', '2026-09-06', 'America/Santiago');
    expect(window.from?.at).toBe('2026-09-06T04:00:00.000Z');
    expect(window.until?.at).toBe('2026-09-07T03:00:00.000Z');
  });

  test('a leap day is a real day; a non-leap February 29 is not', async () => {
    expect(edges('on', '2028-02-29', 'UTC')).toEqual({
      from: '2028-02-29T00:00:00.000Z',
      until: '2028-03-01T00:00:00.000Z',
    });
    await expectMimirError('validation', async () => dateFilterWindow('on', '2027-02-29', 'UTC'));
  });

  test('an impossible calendar date is refused, never rolled forward', async () => {
    for (const value of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10']) {
      await expectMimirError('validation', async () => dateFilterWindow('on', value, 'UTC'));
    }
  });

  test('a bare date with no caller zone is refused', async () => {
    await expectMimirError('validation', async () =>
      dateFilterWindow('on', '2026-06-10', undefined),
    );
  });

  // `Date.UTC` maps years 0-99 into the 1900s, so `0050-01-01` would resolve to
  // a 1950 window — a substituted answer, which this module never gives.
  test.each(['0050-01-01', '0099-12-31', '0000-01-01'])(
    '%s is refused, not remapped',
    async (day) => {
      await expectMimirError('validation', async () => dateFilterWindow('on', day, 'UTC'));
      await expectMimirError('validation', async () =>
        dateFilterWindow('before', `${day}T00:00:00Z`, 'UTC'),
      );
    },
  );

  test('the first supported year still resolves', () => {
    expect(edges('on', '0100-01-01', 'UTC')).toEqual({
      from: '0100-01-01T00:00:00.000Z',
      until: '0100-01-02T00:00:00.000Z',
    });
  });
});

describe('operator semantics', () => {
  const zone = 'America/New_York';
  const opens = '2026-06-10T04:00:00.000Z';
  const nextOpens = '2026-06-11T04:00:00.000Z';

  test('a bare date bounds against the day edges, never a final millisecond', () => {
    expect(edges('before', '2026-06-10', zone)).toEqual({ from: null, until: opens });
    expect(edges('at-or-after', '2026-06-10', zone)).toEqual({ from: opens, until: null });
    expect(edges('after', '2026-06-10', zone)).toEqual({ from: nextOpens, until: null });
    expect(edges('at-or-before', '2026-06-10', zone)).toEqual({ from: null, until: nextOpens });
  });

  test('the day edges are half-open: the opening instant is in, the closing one is out', () => {
    const on = dateFilterWindow('on', '2026-06-10', zone);
    expect(withinWindow(on, opens)).toBe(true);
    expect(withinWindow(on, nextOpens)).toBe(false);
    const atOrBefore = dateFilterWindow('at-or-before', '2026-06-10', zone);
    expect(atOrBefore.until?.inclusive).toBe(false);
    expect(withinWindow(atOrBefore, nextOpens)).toBe(false);
  });

  test('a timestamp is strict for before/after and inclusive for the at-or- pair', () => {
    const instant = '2026-06-10T13:30:00.000Z';
    expect(withinWindow(dateFilterWindow('before', instant, zone), instant)).toBe(false);
    expect(withinWindow(dateFilterWindow('after', instant, zone), instant)).toBe(false);
    expect(withinWindow(dateFilterWindow('at-or-before', instant, zone), instant)).toBe(true);
    expect(withinWindow(dateFilterWindow('at-or-after', instant, zone), instant)).toBe(true);
  });

  test('an offset timestamp normalizes to its UTC instant', () => {
    expect(edges('at-or-after', '2026-07-01T23:00:00+02:00', zone).from).toBe(
      '2026-07-01T21:00:00.000Z',
    );
    expect(edges('before', '2026-07-01T09:30-04:30', zone).until).toBe('2026-07-01T14:00:00.000Z');
  });

  test('seconds and a fractional part are optional but preserved', () => {
    expect(edges('before', '2026-07-01T09:30:15.250Z', zone).until).toBe(
      '2026-07-01T09:30:15.250Z',
    );
    expect(edges('before', '2026-07-01T09:30Z', zone).until).toBe('2026-07-01T09:30:00.000Z');
  });

  // Sub-millisecond digits truncate. Rounding `.9996` up to the next second
  // would widen an `at-or-before` bound past instants the caller excluded.
  test('sub-millisecond digits truncate rather than round', () => {
    expect(edges('at-or-before', '2026-07-01T09:30:00.9996Z', zone).until).toBe(
      '2026-07-01T09:30:00.999Z',
    );
    const window = dateFilterWindow('at-or-before', '2026-07-01T09:30:00.9996Z', zone);
    expect(withinWindow(window, '2026-07-01T09:30:01.000Z')).toBe(false);
    expect(edges('before', '2026-07-01T09:30:00.0009Z', zone).until).toBe(
      '2026-07-01T09:30:00.000Z',
    );
  });

  test('a zone-less or malformed timestamp is refused', async () => {
    for (const value of [
      '2026-07-01T09:30:00',
      '2026-07-01 09:30:00Z',
      '2026-07-01T09Z',
      '2026-07-01T99:00:00Z',
      'yesterday',
    ]) {
      await expectMimirError('validation', async () => dateFilterWindow('before', value, zone));
    }
  });

  test('on takes only a calendar date', async () => {
    await expectMimirError('validation', async () =>
      dateFilterWindow('on', '2026-07-01T09:30:00Z', zone),
    );
  });
});

describe('composition', () => {
  test('intersecting keeps the tighter edge, exclusive breaking a tie', () => {
    const window = dateFilterWindows(
      [
        { field: 'created_at', op: 'at-or-after', value: '2026-06-01' },
        { field: 'created_at', op: 'at-or-after', value: '2026-06-10' },
        { field: 'created_at', op: 'before', value: '2026-07-01' },
      ],
      'UTC',
    );
    expect(window.from?.at).toBe('2026-06-10T00:00:00.000Z');
    expect(window.until?.at).toBe('2026-07-01T00:00:00.000Z');

    const instant = '2026-06-10T00:00:00.000Z';
    const tie = intersectWindows(
      dateFilterWindow('at-or-after', instant, 'UTC'),
      dateFilterWindow('after', instant, 'UTC'),
    );
    expect(tie.from?.inclusive).toBe(false);
  });

  test('an unbounded window admits any parseable instant and no unparseable one', () => {
    const window = dateFilterWindows([], 'UTC');
    expect(withinWindow(window, '2026-06-10T00:00:00.000Z')).toBe(true);
    expect(withinWindow(window, null)).toBe(false);
    expect(withinWindow(window, 'not a timestamp')).toBe(false);
  });

  test('tokens parse as FIELD:VALUE against the resource field', () => {
    const tokens = { 'at-or-after': ['created_at:2026-06-10'] };
    expect(
      parseDateFilterTokens(
        (op) => (op === 'at-or-after' ? tokens['at-or-after'] : []),
        'created_at',
      ),
    ).toEqual([{ field: 'created_at', op: 'at-or-after', value: '2026-06-10' }]);
  });

  test('a token naming another field, or no field at all, is refused', async () => {
    await expectMimirError('validation', async () =>
      parseDateFilterTokens((op) => (op === 'on' ? ['updated_at:2026-06-10'] : []), 'created_at'),
    );
    await expectMimirError('validation', async () =>
      parseDateFilterTokens((op) => (op === 'on' ? ['2026-06-10'] : []), 'created_at'),
    );
  });
});
