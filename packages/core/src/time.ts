/**
 * The single clock and the canonical-instant contract (ADR 0029).
 *
 * Every timestamp the core writes is ISO-8601, UTC, millisecond precision,
 * explicit `Z` — exactly what `Date#toISOString` produces and what the schema's
 * `datetime` columns expect. The core stamps every mutation timestamp through
 * {@link now} — `updated_at`, `completed_at`, `archived_at`, a transition's `at`
 * and an annotation's `created_at` (MMR-173) — and the creation paths
 * (the SQL store's writer, artifact, and seed slices)
 * stamp `created_at`/`updated_at` through it too rather than letting a
 * storage-layer default decide.
 *
 * Since MMR-351 that form is also a PERSISTED invariant, not merely a write
 * convention: lexical string comparison of two stored timestamps must be
 * chronological (`core/intent/queries.ts` orders on raw `updated_at`/
 * `completed_at` strings), which holds only while every stored value shares one
 * width, one precision, and one zone. {@link isCanonicalInstant} is that
 * invariant's predicate; the transfer-document validator and the scratchpad
 * codec refuse a value that is not canonical rather than guess at it.
 *
 * The calendar/instant primitives live here too so the accepted timestamp
 * grammar has exactly ONE implementation: `core/dates.ts` (the query-side date
 * grammar) parses caller input with the parser defined here. This module imports nothing.
 */

/** The single clock: the canonical form, by construction. */
export function now(): string {
  return new Date().toISOString();
}

/** The canonical persisted form — ISO-8601 UTC, millisecond precision, `Z`. */
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A bare calendar date — a human day, not an instant. */
export const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The QUERY-INPUT grammar (ADR 0029, MMR-349): `T`-separated, hours and minutes
 * required, seconds and a fractional part optional, an explicit zone (`Z` or
 * `±HH:MM`) mandatory. It is what a caller may type, and it stays narrow on
 * purpose — one spelling per instant keeps the refusal messages teachable and
 * the surface small. A zone-less timestamp states no instant, and
 * `Date.parse`'s wider leniency (a bare `±HH` offset, month names, "GMT") is
 * never admitted.
 */
const ZONED_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export type CalendarDate = { year: number; month: number; day: number };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);

/**
 * The earliest year this module will resolve. Years 0-99 are refused rather than
 * resolved: `Date.UTC` maps them into the 1900s by a legacy two-digit rule, so
 * `0050-01-01` would silently become a 1950 window — precisely the kind of
 * quiet substitution the rest of this contract exists to refuse. Nothing this
 * tool tracks predates it.
 */
export const MIN_YEAR = 100;

/**
 * A UTC instant from calendar fields, immune to `Date.UTC`'s legacy two-digit
 * year rule (which maps years 0-99 into the 1900s). Years that small are refused
 * at the input boundary, but a *neighbouring* instant can still read as year 99
 * — resolving 0100-01-01 probes the day before it — and a remap there would
 * corrupt the offset a whole zone resolution rests on.
 */
export function utcMillis(
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
 * A strict calendar date, or `null`. Strict is the point: `Date.parse` rolls an
 * out-of-range day (`2026-02-30` becomes March 2), applying a bound the caller
 * never asked for without a word.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
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

/** An explicitly zoned timestamp as its epoch instant, or `null` — the
 * QUERY-INPUT grammar (what a caller may type). */
export function parseZonedInstant(value: string): number | null {
  const match = ZONED_TIMESTAMP.exec(value);
  return match === null ? null : instantFromMatch(value, match);
}

/** The arithmetic behind {@link parseZonedInstant}: calendar fields and a
 * numeric offset to one epoch instant. Every date, time, and offset component is
 * range-checked — the regexes constrain shape, never magnitude. */
function instantFromMatch(value: string, match: RegExpExecArray): number | null {
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

/**
 * Is `value` already the canonical persisted form? The regex fixes the shape,
 * the round trip fixes the calendar (`2026-02-30T00:00:00.000Z` has the shape
 * but is no day, so only a value `Date` reproduces byte-for-byte passes), and
 * {@link MIN_YEAR} fixes the era.
 *
 * That last bound keeps this predicate in step with the query grammar, which
 * already refuses to write a year below {@link MIN_YEAR}: a stored value from
 * that era is corruption, and it reads as such whatever its spelling.
 */
export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MILLIS.test(value)) {
    return false;
  }
  if (Number(value.slice(0, 4)) < MIN_YEAR) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
