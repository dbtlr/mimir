import { ago as agoIn, formatDay, relativeTime as relativeTimeIn } from '@mimir/helpers';

/** The reader's own zone — the console renders every timestamp in it (ADR 0029). */
const localZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w". */
export function relativeTime(iso: string | number, now = Date.now()): string {
  return relativeTimeIn(iso, now);
}

/** Relative time as a phrase: "just now" / "4m ago". */
export function ago(iso: string | number, now = Date.now()): string {
  return agoIn(iso, now);
}

/** Full local timestamp for the drawer's meta rows, with its zone label — an
 * absolute reading is ambiguous without one. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString(undefined, { timeZoneName: 'short' });
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
