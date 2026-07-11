/**
 * Artifact-browser derivations (MMR-229): the KIND/TAGS split and the master
 * list's recency grouping. Both are read-side conventions, not wire fields —
 * `kind` is the `kind:` tag namespace (ADR 0005 grouping-by-tags), and the
 * date buckets are derived locally from `created_at`.
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

/** One master-list date section; `recent` gates the older-row demotion. */
export type RecencyGroup<T> = {
  label: string;
  items: T[];
  /** THIS WEEK / LAST WEEK — older (month) groups render demoted. */
  recent: boolean;
};

const MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
] as const;

/** Midnight starting the (Monday-first) week containing `at`, local time. */
function weekStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d.getTime();
}

/**
 * Bucket rows into the master list's date sections: THIS WEEK, LAST WEEK,
 * then month buckets (`MAY 2026`); undatable rows land in EARLIER. Input
 * order is preserved within a group (the API serves newest first) and groups
 * appear in encounter order.
 */
export function groupByRecency<T extends { created_at: string }>(
  items: T[],
  now = Date.now(),
): RecencyGroup<T>[] {
  const thisWeek = weekStart(now);
  const lastWeek = thisWeek - 7 * 24 * 60 * 60 * 1000;

  const labelOf = (iso: string): { label: string; recent: boolean } => {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) {
      return { label: 'EARLIER', recent: false };
    }
    if (at >= thisWeek) {
      return { label: 'THIS WEEK', recent: true };
    }
    if (at >= lastWeek) {
      return { label: 'LAST WEEK', recent: true };
    }
    const d = new Date(at);
    return {
      label: `${MONTHS[d.getMonth()] ?? 'EARLIER'} ${String(d.getFullYear())}`,
      recent: false,
    };
  };

  const groups: RecencyGroup<T>[] = [];
  const byLabel = new Map<string, RecencyGroup<T>>();
  for (const item of items) {
    const { label, recent } = labelOf(item.created_at);
    let group = byLabel.get(label);
    if (group === undefined) {
      group = { items: [], label, recent };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
