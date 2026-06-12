/** Compact relative time for dense surfaces: "now", "4m", "3h", "6d", "8w". */
export function relativeTime(iso: string | number, now = Date.now()): string {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(at)) {
    return "—";
  }
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${String(d)}d`;
  return `${String(Math.floor(d / 7))}w`;
}

/** Relative time as a phrase: "just now" / "4m ago". */
export function ago(iso: string | number, now = Date.now()): string {
  const rel = relativeTime(iso, now);
  return rel === "now" ? "just now" : `${rel} ago`;
}

/** Full local timestamp for the drawer's meta rows. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : at.toLocaleString();
}
