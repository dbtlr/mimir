/** The age text `mimir-host` listings share. */

/** A span as its largest whole unit: `3m`, `2h`, `5d`; under a minute is `<1m`. */
export function span(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}
