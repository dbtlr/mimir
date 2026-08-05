import { DATE_OP_VALUES } from '@mimir/contract';
import type { DateOp } from '@mimir/contract';

import { validation } from './errors';

/**
 * The date-query core (ADR 0029). Every transport hands raw filter text plus the
 * caller's IANA timezone to this module and gets back an instant window; no
 * transport performs date arithmetic of its own.
 *
 * Two value shapes are accepted. A bare `YYYY-MM-DD` is a human calendar value
 * resolved through the caller's zone, so its window carries the real 23-, 24-, or
 * 25-hour length that zone's rules produce. A timestamp is an instant and must
 * carry `Z` or a numeric UTC offset — a zone-less one is rejected rather than
 * silently read as UTC or host-local time, which made the same query mean two
 * things on two machines.
 *
 * Windows are half-open where the calendar is: `on 2026-03-08` runs from that
 * day's opening instant up to (never including) the next day's, so nothing here
 * ever synthesizes a `23:59:59.999` final millisecond.
 */

/** One edge of an instant window — the canonical instant plus whether it matches. */
export type InstantBound = {
  /** Canonical ISO-8601 UTC, millisecond precision. */
  at: string;
  epochMs: number;
  inclusive: boolean;
};

/** A resolved date filter: a lower edge, an upper edge, either or both unbounded. */
export type InstantWindow = {
  from: InstantBound | null;
  until: InstantBound | null;
};

/** The window that admits every instant — the identity for {@link intersectWindows}. */
export const ANY_INSTANT: InstantWindow = { from: null, until: null };

/** One field-qualified date filter, pre-resolution. */
export type DateFilter = {
  field: string;
  op: DateOp;
  value: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The accepted timestamp shape (ADR 0029): `T`-separated, hours and minutes
 * required, seconds and a fractional part optional, and an explicit zone —
 * `Z` or a numeric `±HH:MM` offset — mandatory.
 */
const ZONED_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** A queryable field's shape — what a `FIELD:VALUE` prefix must look like. */
const FIELD_NAME = /^[a-z][a-z_]*$/;

/** A zone name's admissible characters — excludes the `±HH:MM` offset forms
 * `Intl` may otherwise accept, which are not IANA zones and carry no DST rules. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+/-]*$/;

const timeZoneHint = 'pass an IANA timezone (tz), e.g. America/New_York';

const formatters = new Map<string, Intl.DateTimeFormat>();
let supportedZones: ReadonlySet<string> | undefined;

/** Is `name` an IANA timezone this runtime knows? The canonical list first, then
 * the constructor, which also admits aliases the list omits (`UTC`, `Zulu`). */
export function isTimeZone(name: string): boolean {
  if (!ZONE_NAME.test(name)) {
    return false;
  }
  supportedZones ??= new Set(Intl.supportedValuesOf('timeZone'));
  if (supportedZones.has(name)) {
    return true;
  }
  try {
    // The constructor is the probe: an unknown zone throws a RangeError.
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/** The invoking system's IANA timezone — the CLI's default caller zone. */
export function systemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Validate a caller-supplied zone, or `undefined` for "the caller sent none". */
export function requireTimeZone(zone: string | undefined): string | undefined {
  if (zone === undefined || zone === '') {
    return undefined;
  }
  if (!isTimeZone(zone)) {
    throw validation(`unknown timezone: ${zone}`, timeZoneHint);
  }
  return zone;
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: zone,
    year: 'numeric',
  });
  formatters.set(zone, formatter);
  return formatter;
}

/**
 * A UTC instant from calendar fields, immune to `Date.UTC`'s legacy two-digit
 * year rule (which maps years 0-99 into the 1900s). Years that small are refused
 * at the input boundary, but a *neighbouring* instant can still read as year 99
 * — resolving 0100-01-01 probes the day before it — and a remap there would
 * corrupt the offset the whole resolution rests on.
 */
function utcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

/**
 * The wall-clock reading of instant `epochMs` in `zone`, expressed as the epoch
 * value that same reading would have in UTC. `wall(t) - t` is therefore the
 * zone's UTC offset at `t`, which is the whole basis of the resolution below.
 * Sub-second digits ride along untouched: zone offsets are whole minutes.
 */
function wallClock(epochMs: number, zone: string): number {
  const parts = formatterFor(zone).formatToParts(epochMs);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const whole = utcMillis(
    field('year'),
    field('month'),
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return whole + (((epochMs % 1000) + 1000) % 1000);
}

/** The zone's UTC offset at an instant, in milliseconds. */
const offsetAt = (epochMs: number, zone: string): number => wallClock(epochMs, zone) - epochMs;

/** A span over which the zone's offset is constant — `[start, end)`. */
type OffsetSegment = { start: number; end: number; offset: number };

/** How far either side of UTC midnight the day's opening instant can lie: real
 * offsets span −12…+14, and a search window of 20 hours clears both with room. */
const SEARCH_SPAN_MS = 20 * 60 * 60 * 1000;

/**
 * The zone's constant-offset segments across `[from, to]`, split at every
 * transition in range. Found by bisecting on the offset itself: a day with no
 * transition costs two reads, and one with a transition costs ~50 rather than a
 * scan. Sub-millisecond precision is not needed — transitions land on a minute.
 */
function offsetSegments(from: number, to: number, zone: string): OffsetSegment[] {
  const boundaries: { at: number; offset: number }[] = [];
  const split = (low: number, lowOffset: number, high: number, highOffset: number): void => {
    if (lowOffset === highOffset) {
      return;
    }
    if (high - low <= 1) {
      boundaries.push({ at: high, offset: highOffset });
      return;
    }
    const mid = low + Math.floor((high - low) / 2);
    const midOffset = offsetAt(mid, zone);
    split(low, lowOffset, mid, midOffset);
    split(mid, midOffset, high, highOffset);
  };
  const fromOffset = offsetAt(from, zone);
  split(from, fromOffset, to, offsetAt(to, zone));

  const segments: OffsetSegment[] = [];
  let start = from;
  let offset = fromOffset;
  for (const boundary of boundaries) {
    segments.push({ end: boundary.at, offset, start });
    start = boundary.at;
    offset = boundary.offset;
  }
  segments.push({ end: to, offset, start });
  return segments;
}

/**
 * The instant a local calendar day opens in `zone` — the EARLIEST instant whose
 * wall clock reads at or after that day's midnight.
 *
 * Inside one offset segment the wall clock is just `t + offset`, so the earliest
 * qualifying instant there is a clamp, not a search: `max(segmentStart, midnight
 * − offset)`, kept only if it still falls inside the segment. The day opens at
 * the smallest such instant across the segments around it. That formulation is
 * what makes the irregular days fall out rather than needing special cases:
 *
 * - **repeated midnight** (a fall-back at or just after 00:00, e.g. Asia/Amman
 *   2021-10-29) qualifies in BOTH segments, and the earlier one — the first of
 *   the two real midnights — wins, so the day is its true 25 hours long.
 * - **skipped midnight** (a spring-forward at 00:00, e.g. America/Santiago) has
 *   no qualifying instant in the pre-transition segment, because the clamp lands
 *   at or past its end; the day opens at the transition, its first real instant.
 * - a **skipped day** (Pacific/Apia 2011-12-30) opens where the next day opens,
 *   which is exactly the empty window it should be.
 */
function dayOpensAt(year: number, month: number, day: number, zone: string): number {
  const asUTC = utcMillis(year, month, day);
  const memoKey = `${zone}|${String(asUTC)}`;
  const memoized = dayOpenings.get(memoKey);
  if (memoized !== undefined) {
    return memoized;
  }
  let opens = asUTC + SEARCH_SPAN_MS;
  for (const segment of offsetSegments(asUTC - SEARCH_SPAN_MS, asUTC + SEARCH_SPAN_MS, zone)) {
    const candidate = Math.max(segment.start, asUTC - segment.offset);
    if (candidate < segment.end && candidate < opens) {
      opens = candidate;
    }
  }
  if (dayOpenings.size >= DAY_OPENING_CACHE_CAP) {
    dayOpenings.clear();
  }
  dayOpenings.set(memoKey, opens);
  return opens;
}

/** Resolved day openings, memoized: zone rules never change mid-process, and one
 * query resolves the same day repeatedly (a window needs two, filters compose). */
const dayOpenings = new Map<string, number>();
const DAY_OPENING_CACHE_CAP = 512;

type CalendarDate = { year: number; month: number; day: number };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);

/**
 * The earliest year the module will resolve. Years 0-99 are refused rather than
 * resolved: `Date.UTC` maps them into the 1900s by a legacy two-digit rule, so
 * `0050-01-01` would silently become a 1950 window — precisely the kind of
 * quiet substitution the rest of this module exists to refuse. Nothing this
 * tool tracks predates it.
 */
const MIN_YEAR = 100;

/**
 * A strict calendar date, or `null`. Strict is the point: `Date.parse` rolls an
 * out-of-range day (`2026-02-30` becomes March 2), applying a bound the caller
 * never asked for without a word.
 */
function parseCalendarDate(value: string): CalendarDate | null {
  const match = BARE_DATE.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { day, month, year };
}

/** The calendar date after `date`. */
function nextDay(date: CalendarDate): CalendarDate {
  const rolled = new Date(utcMillis(date.year, date.month, date.day) + DAY_MS);
  return {
    day: rolled.getUTCDate(),
    month: rolled.getUTCMonth() + 1,
    year: rolled.getUTCFullYear(),
  };
}

/** An explicitly zoned timestamp as its epoch instant, or `null`. */
function parseZonedTimestamp(value: string): number | null {
  const match = ZONED_TIMESTAMP.exec(value);
  if (match === null) {
    return null;
  }
  const date = parseCalendarDate(value.slice(0, 10));
  if (date === null) {
    return null;
  }
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? '0')];
  // Sub-millisecond digits are TRUNCATED, never rounded: rounding `.9996` up to
  // a whole second would move an `at-or-before` bound past instants the caller
  // excluded. Read off the digits rather than scaling a float, which is exact.
  const fraction = Number(`${(match[7] ?? '.').slice(1)}000`.slice(0, 3));
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const offsetHours = Number(match[9] ?? '0');
  const offsetMinutes = Number(match[10] ?? '0');
  if (offsetHours > 23 || offsetMinutes > 59) {
    return null;
  }
  const offset = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  return utcMillis(date.year, date.month, date.day, hour, minute, second, fraction) - offset;
}

const bound = (epochMs: number, inclusive: boolean): InstantBound => ({
  at: new Date(epochMs).toISOString(),
  epochMs,
  inclusive,
});

/**
 * Resolve one date filter to its instant window (ADR 0029). A bare date needs the
 * caller's zone; a timestamp carries its own. `on` accepts a bare date only — an
 * instant is not a calendar day.
 */
export function dateFilterWindow(
  op: DateOp,
  value: string,
  zone: string | undefined,
): InstantWindow {
  const date = parseCalendarDate(value);
  if (date !== null) {
    if (zone === undefined) {
      throw validation(`${value} is a calendar date with no caller timezone`, timeZoneHint);
    }
    return calendarWindows(date, zone)[op];
  }
  // Date-shaped but not a real day (`2026-02-30`): the same refusal every
  // operator gives, so the fault reads as the calendar's, not the operator's.
  if (BARE_DATE.test(value)) {
    throw validation(`invalid date: ${value}`, calendarFaultHint(value));
  }
  if (op === 'on') {
    throw validation(`${value} is not a calendar date`, 'on takes a bare YYYY-MM-DD date');
  }
  const instant = parseZonedTimestamp(value);
  if (instant === null) {
    throw validation(`invalid date: ${value}`, dateValueHint(value));
  }
  return instantWindows(instant)[op];
}

/** The five windows a caller-local calendar day describes — the day's own opening
 * and closing instants, never a synthesized final millisecond. */
function calendarWindows(date: CalendarDate, zone: string): Record<DateOp, InstantWindow> {
  const opens = dayOpensAt(date.year, date.month, date.day, zone);
  const next = nextDay(date);
  const closes = dayOpensAt(next.year, next.month, next.day, zone);
  return {
    after: { from: bound(closes, true), until: null },
    'at-or-after': { from: bound(opens, true), until: null },
    'at-or-before': { from: null, until: bound(closes, false) },
    before: { from: null, until: bound(opens, false) },
    on: { from: bound(opens, true), until: bound(closes, false) },
  };
}

/** The four windows an instant describes — strict for before/after, inclusive for
 * the at-or- pair. `on` never reaches here: an instant is not a calendar day. */
function instantWindows(instant: number): Record<Exclude<DateOp, 'on'>, InstantWindow> {
  return {
    after: { from: bound(instant, false), until: null },
    'at-or-after': { from: bound(instant, true), until: null },
    'at-or-before': { from: null, until: bound(instant, true) },
    before: { from: null, until: bound(instant, false) },
  };
}

/** Why a date-shaped value is not a date: an unsupported year, or a day that
 * month never had. */
function calendarFaultHint(value: string): string {
  return Number(value.slice(0, 4)) < MIN_YEAR
    ? `the year must be ${String(MIN_YEAR).padStart(4, '0')} or later`
    : `${value.slice(0, 7)} has no such day`;
}

/** The correction for a rejected value — a zone-less timestamp is its own fault. */
function dateValueHint(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) {
    return 'a timestamp needs an explicit zone: 2026-08-01T09:30:00Z or 2026-08-01T09:30:00-04:00';
  }
  return 'takes YYYY-MM-DD or a zoned ISO timestamp (2026-08-01T09:30:00Z)';
}

const tighterFrom = (a: InstantBound | null, b: InstantBound | null): InstantBound | null => {
  if (a === null || b === null) {
    return a ?? b;
  }
  if (a.epochMs !== b.epochMs) {
    return a.epochMs > b.epochMs ? a : b;
  }
  return a.inclusive ? b : a;
};

const tighterUntil = (a: InstantBound | null, b: InstantBound | null): InstantBound | null => {
  if (a === null || b === null) {
    return a ?? b;
  }
  if (a.epochMs !== b.epochMs) {
    return a.epochMs < b.epochMs ? a : b;
  }
  return a.inclusive ? b : a;
};

/** AND two windows — the tighter edge wins, exclusive breaking a tie. */
export function intersectWindows(a: InstantWindow, b: InstantWindow): InstantWindow {
  return { from: tighterFrom(a.from, b.from), until: tighterUntil(a.until, b.until) };
}

/** Does a stored timestamp fall in the window? An absent or unparseable value never does. */
export function withinWindow(window: InstantWindow, value: string | null | undefined): boolean {
  if (value == null || value === '') {
    return false;
  }
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    return false;
  }
  const { from, until } = window;
  if (from !== null && (from.inclusive ? epochMs < from.epochMs : epochMs <= from.epochMs)) {
    return false;
  }
  return until === null || (until.inclusive ? epochMs <= until.epochMs : epochMs < until.epochMs);
}

/**
 * Parse the five date-op token lists of a resource whose only date field is
 * `field` (artifacts and seeds — `created_at`). `tokensFor` is the transport's
 * accessor over its own argument shape, so CLI flags, MCP array args, and HTTP
 * repeated query params reach one parser.
 */
export function parseDateFilterTokens(
  tokensFor: (op: DateOp) => readonly string[],
  field: string,
): DateFilter[] {
  const filters: DateFilter[] = [];
  for (const op of DATE_OP_VALUES) {
    for (const token of tokensFor(op)) {
      const split = token.indexOf(':');
      const named = split > 0 ? token.slice(0, split) : '';
      // A bare value carries colons of its own (`2026-07-01T09:30Z`), so the
      // prefix has to LOOK like a field name before it can be blamed as one.
      if (!FIELD_NAME.test(named)) {
        throw validation(
          `${op} expects FIELD:VALUE, got "${token}"`,
          `qualify the value with the date field: ${field}:${token}`,
        );
      }
      if (named !== field) {
        throw validation(`${op} applies to ${field}, not ${named}`);
      }
      filters.push({ field, op, value: token.slice(split + 1) });
    }
  }
  return filters;
}

/** Resolve same-field date filters to the one window their conjunction describes. */
export function dateFilterWindows(
  filters: readonly DateFilter[],
  zone: string | undefined,
): InstantWindow {
  return filters.reduce(
    (window, filter) => intersectWindows(window, dateFilterWindow(filter.op, filter.value, zone)),
    ANY_INSTANT,
  );
}
