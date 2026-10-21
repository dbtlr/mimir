import { ago as agoIn, formatDay, relativeTime as relativeTimeIn } from '@mimir/helpers';

/** The reader's own zone — the console renders every timestamp in it (ADR 0029). */
const localZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * An instant as a read carries it: a `Date` from an Engine read, or its ISO
 * string.
 */
export type Instant = string | Date;

/** What the shared helpers read: the ISO string, or a `Date`'s epoch milliseconds. */
const readable = (at: Instant | number): string | number =>
  at instanceof Date ? at.getTime() : at;

/** Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w",
 * "10mo", "3y". */
export function relativeTime(at: Instant | number, now = Date.now()): string {
  return relativeTimeIn(readable(at), now);
}

/** Relative time as a phrase: "just now" / "4m ago". */
export function ago(at: Instant | number, now = Date.now()): string {
  return agoIn(readable(at), now);
}

/** Time left until a future instant, as a phrase: "in 9m" / "in <1m"; "now" once it has passed. */
export function until(at: Instant | number, now = Date.now()): string {
  const target = new Date(readable(at)).getTime();
  if (target <= now) {
    return 'now';
  }
  // The shared ladder reads a past instant; swapping the arguments reads the time left.
  const left = relativeTimeIn(now, target);
  return left === 'now' ? 'in <1m' : `in ${left}`;
}

/** Full local timestamp for a record page's meta rows, with its zone label — an
 * absolute reading is ambiguous without one. The locale is pinned to `en-US`
 * like the CLI helpers': the zone read from the machine, the spelling never, so
 * two operators reading the same record read the same string. */
export function absoluteTime(at: Instant): string {
  const instant = new Date(at);
  return Number.isNaN(instant.getTime())
    ? '—'
    : instant.toLocaleString('en-US', { timeZoneName: 'short' });
}

/** Local calendar date, `YYYY-MM-DD` — the reader's FROZEN microlabel. */
export function calendarDate(at: Instant): string {
  return formatDay(readable(at), localZone());
}

/** Local `MM-DD` — dense row meta and the mobile FROZEN microlabel. */
export function shortDate(at: Instant): string {
  const full = calendarDate(at);
  return full === '—' ? full : full.slice(5);
}
