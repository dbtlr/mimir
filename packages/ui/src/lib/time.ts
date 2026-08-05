import { ago as agoIn, formatDay, relativeTime as relativeTimeIn } from '@mimir/helpers';

/** The reader's own zone — the console renders every timestamp in it (ADR 0029). */
const localZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w",
 * "10mo", "3y". */
export function relativeTime(iso: string | number, now = Date.now()): string {
  return relativeTimeIn(iso, now);
}

/** Relative time as a phrase: "just now" / "4m ago". */
export function ago(iso: string | number, now = Date.now()): string {
  return agoIn(iso, now);
}

/** Full local timestamp for the drawer's meta rows, with its zone label — an
 * absolute reading is ambiguous without one. The locale is pinned to `en-US`
 * like the CLI helpers': the zone read from the machine, the spelling never, so
 * two operators reading the same record read the same string. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString('en-US', { timeZoneName: 'short' });
}

/** Local calendar date, `YYYY-MM-DD` — the reader's FROZEN microlabel. */
export function calendarDate(iso: string): string {
  return formatDay(iso, localZone());
}

/** Local `MM-DD` — dense row meta and the mobile FROZEN microlabel. */
export function shortDate(iso: string): string {
  const full = calendarDate(iso);
  return full === '—' ? full : full.slice(5);
}
