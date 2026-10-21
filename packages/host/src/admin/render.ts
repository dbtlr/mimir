/** The text pieces `mimir-host` listings share: aligned columns, ages, and instants. */

/** `rows` under `headers`, each column padded to its widest cell, two spaces apart. */
export function columns(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, at) =>
    Math.max(header.length, ...rows.map((row) => (row[at] ?? '').length)),
  );
  return [headers, ...rows]
    .map((cells) =>
      cells
        .map((cell, at) => cell.padEnd(widths[at] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

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

/** An instant as `YYYY-MM-DD HH:MM` in `zone`, or `-` when there is none. */
export function instant(at: string | null, zone: string): string {
  if (at === null) {
    return '-';
  }
  return new Intl.DateTimeFormat('sv-SE', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: zone,
    year: 'numeric',
  }).format(new Date(at));
}
