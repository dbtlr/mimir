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
 * The wall-clock reading of instant `epochMs` in `zone`, expressed as the epoch
 * value that same reading would have in UTC. `wall(t) - t` is therefore the
 * zone's UTC offset at `t`, which is the whole basis of the resolution below.
 * Sub-second digits ride along untouched: zone offsets are whole minutes.
 */
function wallClock(epochMs: number, zone: string): number {
  const parts = formatterFor(zone).formatToParts(epochMs);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const whole = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return whole + (((epochMs % 1000) + 1000) % 1000);
}

/**
 * The instant a local calendar day opens in `zone`.
 *
 * Guess-and-correct: subtract the offset read at UTC midnight, then re-read the
 * offset at that guess — two passes settle every ordinary day and every day whose
 * transition happens after midnight. Two irregular days remain:
 *
 * - **repeated midnight** (a fall-back at 00:00): both guesses land on a real
 *   local midnight, and the day opens at the EARLIER of them.
 * - **skipped midnight** (a spring-forward at 00:00): neither guess reads as
 *   local midnight, so the day opens at its first existing instant — the
 *   transition itself, bisected between the two guesses, which straddle it.
 */
function dayOpensAt(year: number, month: number, day: number, zone: string): number {
  const asUTC = Date.UTC(year, month - 1, day);
  const first = asUTC - (wallClock(asUTC, zone) - asUTC);
  const second = asUTC - (wallClock(first, zone) - first);
  const exact = [first, second].filter((guess) => wallClock(guess, zone) === asUTC);
  if (exact.length > 0) {
    return Math.min(...exact);
  }
  let low = Math.min(first, second);
  let high = Math.max(first, second);
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (wallClock(mid, zone) >= asUTC) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

type CalendarDate = { year: number; month: number; day: number };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);

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
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { day, month, year };
}

/** The calendar date after `date`. */
function nextDay(date: CalendarDate): CalendarDate {
  const rolled = new Date(Date.UTC(date.year, date.month - 1, date.day) + DAY_MS);
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
  const fraction = match[7] === undefined ? 0 : Math.round(Number(match[7]) * 1000);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const offsetHours = Number(match[9] ?? '0');
  const offsetMinutes = Number(match[10] ?? '0');
  if (offsetHours > 23 || offsetMinutes > 59) {
    return null;
  }
  const offset = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  return Date.UTC(date.year, date.month - 1, date.day, hour, minute, second, fraction) - offset;
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
    throw validation(`invalid date: ${value}`, `${value.slice(0, 7)} has no such day`);
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
