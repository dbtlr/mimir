/**
 * Human-facing time rendering (ADR 0029). Machine formats stay canonical UTC
 * ISO instants; every surface a person reads renders in a zone the caller names
 * and carries a visible zone label — an abbreviation where one exists, the GMT
 * offset where it doesn't. Intl and native `Date` only, like the rest of this
 * package.
 *
 * The absolute forms are assembled from `formatToParts` rather than a locale
 * pattern: the date/time portion is `YYYY-MM-DD HH:mm` on every machine, so two
 * operators reading the same record read the same string.
 */

/** What every formatter returns for an instant it cannot read (ADR 0017). */
const UNREADABLE = '—';

/** One formatter per zone — construction is expensive and zone rules never
 * change mid-process. */
const formatters = new Map<string, Intl.DateTimeFormat>();

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
    timeZone: zone,
    timeZoneName: 'short',
    year: 'numeric',
  });
  formatters.set(zone, formatter);
  return formatter;
}

const read = (
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string => parts.find((part) => part.type === type)?.value ?? '';

/** An instant as epoch milliseconds, or `null` when the value is unreadable. */
function epochOf(iso: string | number): number | null {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * Absolute local wall clock with its zone label — `2026-08-05 09:14 EDT`. The
 * label is what makes the value unambiguous, so it is never optional.
 */
export function formatInstant(iso: string | number, zone: string): string {
  const at = epochOf(iso);
  if (at === null) {
    return UNREADABLE;
  }
  const parts = formatterFor(zone).formatToParts(at);
  const day = `${read(parts, 'year')}-${read(parts, 'month')}-${read(parts, 'day')}`;
  return `${day} ${read(parts, 'hour')}:${read(parts, 'minute')} ${read(parts, 'timeZoneName')}`;
}

/** The local calendar day of an instant in `zone`, `YYYY-MM-DD`. */
export function formatDay(iso: string | number, zone: string): string {
  const at = epochOf(iso);
  if (at === null) {
    return UNREADABLE;
  }
  const parts = formatterFor(zone).formatToParts(at);
  return `${read(parts, 'year')}-${read(parts, 'month')}-${read(parts, 'day')}`;
}

/** Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w". */
export function relativeTime(iso: string | number, nowMs: number): string {
  const at = epochOf(iso);
  if (at === null) {
    return UNREADABLE;
  }
  const s = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (s < 60) {
    return 'now';
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${String(m)}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${String(h)}h`;
  }
  const d = Math.floor(h / 24);
  if (d < 14) {
    return `${String(d)}d`;
  }
  return `${String(Math.floor(d / 7))}w`;
}

/** Relative time as a phrase: "just now" / "4m ago". */
export function ago(iso: string | number, nowMs: number): string {
  const rel = relativeTime(iso, nowMs);
  return rel === 'now' ? 'just now' : `${rel} ago`;
}
