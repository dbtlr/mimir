/**
 * Artifact-browser derivations (MMR-229, MMR-454): the KIND/TAGS split and the
 * list's grouping by local day. Both are read-side conventions, not wire
 * fields — `kind` is the `kind:` tag namespace (ADR 0005 grouping-by-tags),
 * and the day groups are derived locally from `created_at`.
 */

/** The tag namespace the browser renders as KIND rather than a plain tag. */
const KIND_PREFIX = 'kind:';

/**
 * Split an artifact's tags into its KIND (the first `kind:`-namespaced tag,
 * prefix stripped) and the remaining plain tags. No `kind:` tag → no kind;
 * any extra `kind:` tags stay in the remainder verbatim.
 */
export function splitKindTags(tags: string[]): { kind: string | undefined; rest: string[] } {
  const kindTag = tags.find((t) => t.startsWith(KIND_PREFIX) && t.length > KIND_PREFIX.length);
  return {
    kind: kindTag?.slice(KIND_PREFIX.length),
    rest: tags.filter((t) => t !== kindTag),
  };
}

/** The one kind spelled as a bare tag rather than under `kind:` (session retrospectives). */
const BARE_KIND_TAGS: ReadonlySet<string> = new Set(['session_summary']);

/** Kind tags worth offering before any row shows them. */
const WELL_KNOWN_KIND_TAGS: readonly string[] = [
  'session_summary',
  'kind:spec',
  'kind:session',
  'kind:shaping',
  'kind:bug',
];

/** What a tag says about its kind: the kind's name, or undefined for a plain tag. */
export function kindTagLabel(tag: string): string | undefined {
  if (tag.startsWith(KIND_PREFIX) && tag.length > KIND_PREFIX.length) {
    return tag.slice(KIND_PREFIX.length);
  }
  return BARE_KIND_TAGS.has(tag) ? tag : undefined;
}

/** Every kind an artifact carries, in tag order (a row may carry several). */
export function kindsOf(tags: readonly string[]): string[] {
  return tags.flatMap((t) => {
    const kind = kindTagLabel(t);
    return kind === undefined ? [] : [kind];
  });
}

/**
 * The kind menu's options: the well-known kind tags, then any kind seen in the
 * loaded rows, then the one currently chosen (so a URL-addressed kind always
 * has a row in the menu). `tag` is what the `tag` filter takes; `label` is the
 * kind's name.
 */
export function kindTagOptions(
  rowTags: readonly (readonly string[])[],
  chosen: string | undefined,
): { tag: string; label: string }[] {
  const seen = new Set<string>(WELL_KNOWN_KIND_TAGS);
  for (const tags of rowTags) {
    for (const t of tags) {
      if (kindTagLabel(t) !== undefined) {
        seen.add(t);
      }
    }
  }
  if (chosen !== undefined && kindTagLabel(chosen) !== undefined) {
    seen.add(chosen);
  }
  return [...seen].map((tag) => ({ label: kindTagLabel(tag) ?? tag, tag }));
}

/** One day's rows under its list header (`Today`, `Oct 6`, `Oct 6, 2025`). */
export type DayGroup<T> = { key: string; label: string; items: T[] };

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** A stable per-local-day key. */
function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
}

/** The header for a local day, relative to `now`. */
function dayLabel(d: Date, now: Date): string {
  if (dayKey(d) === dayKey(now)) {
    return 'Today';
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) {
    return 'Yesterday';
  }
  const month = `${MONTHS[d.getMonth()] ?? ''} ${String(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? month : `${month}, ${String(d.getFullYear())}`;
}

/**
 * Group rows by the local calendar day they were created on. Input order is
 * kept within a group (the API serves newest first) and groups appear in
 * encounter order, so a newest-first feed yields newest-first days. Rows with
 * no readable date land together under `Earlier`.
 */
export function groupByDay<T extends { created_at: string }>(
  items: T[],
  now = Date.now(),
): DayGroup<T>[] {
  const today = new Date(now);
  const groups: DayGroup<T>[] = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const at = new Date(item.created_at);
    const valid = !Number.isNaN(at.getTime());
    const key = valid ? dayKey(at) : 'earlier';
    let group = byKey.get(key);
    if (group === undefined) {
      group = { items: [], key, label: valid ? dayLabel(at, today) : 'Earlier' };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
