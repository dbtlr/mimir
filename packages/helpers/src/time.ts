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
export const UNREADABLE = '—';

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

/** `year: 'numeric'` does not zero-pad, so year 999 would break the module's
 * `YYYY-MM-DD` shape guarantee (and `shortDate`'s `slice(5)`). Years past 9999
 * are simply longer, which is the only honest rendering. */
const year = (parts: readonly Intl.DateTimeFormatPart[]): string =>
  read(parts, 'year').padStart(4, '0');

/** The widest instant `Date` — and therefore `formatToParts` — can read; beyond
 * it the formatter throws rather than returning a value. */
const MAX_EPOCH_MS = 8.64e15;

/** An instant as epoch milliseconds, or `null` when the value is unreadable —
 * which includes NaN, the infinities, and anything outside the representable
 * range, all of which must render the placeholder rather than throw. */
function epochOf(iso: string | number): number | null {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(at) && Math.abs(at) <= MAX_EPOCH_MS ? at : null;
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
  const day = `${year(parts)}-${read(parts, 'month')}-${read(parts, 'day')}`;
  return `${day} ${read(parts, 'hour')}:${read(parts, 'minute')} ${read(parts, 'timeZoneName')}`;
}

/** The local calendar day of an instant in `zone`, `YYYY-MM-DD`. */
export function formatDay(iso: string | number, zone: string): string {
  const at = epochOf(iso);
  if (at === null) {
    return UNREADABLE;
  }
  const parts = formatterFor(zone).formatToParts(at);
  return `${year(parts)}-${read(parts, 'month')}-${read(parts, 'day')}`;
}

/**
 * Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w",
 * "10mo", "3y". The ladder runs all the way to years because an artifact feed
 * outlives the week: "521w" is a number nobody reads as a decade. Months and
 * years are the usual approximations — 30 and 365 days — in keeping with the
 * rest of the ladder, which trades exactness for a glanceable width.
 */
export function relativeTime(iso: string | number, nowMs: number): string {
  const at = epochOf(iso);
  if (at === null || !Number.isFinite(nowMs)) {
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
  if (d < 60) {
    return `${String(Math.floor(d / 7))}w`;
  }
  if (d < 365) {
    return `${String(Math.floor(d / 30))}mo`;
  }
  return `${String(Math.floor(d / 365))}y`;
}

/** Relative time as a phrase: "just now" / "4m ago" / "3y ago". */
export function ago(iso: string | number, nowMs: number): string {
  const rel = relativeTime(iso, nowMs);
  if (rel === UNREADABLE) {
    return UNREADABLE;
  }
  return rel === 'now' ? 'just now' : `${rel} ago`;
}
