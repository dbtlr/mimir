import type { Distribution } from '@mimir/contract';

/**
 * The Overview project card's leaf-count row (MMR-226): four operator-facing
 * tallies drawn from the leaf-counts facet — `live` / `ready` / `review`, plus a
 * single `held` bucket that folds the three stalled states (awaiting + blocked +
 * parked) so a resting count reads as one figure. Distinct from `cardVitals`,
 * whose five ungrouped states serve a different, denser legend; this surface
 * groups. Zero-count items are dropped (the mock never shows a `0 live`).
 */

export type OverviewCount = {
  /** Stable key for React and per-lane filtering. */
  key: 'live' | 'ready' | 'review' | 'held';
  label: string;
  count: number;
  /** The status-hue text class for the bold count figure. */
  text: string;
};

export function overviewCardCounts(counts: Distribution | undefined): OverviewCount[] {
  const c = counts ?? {};
  const held = (c.awaiting ?? 0) + (c.blocked ?? 0) + (c.parked ?? 0);
  const items: OverviewCount[] = [
    { count: c.in_progress ?? 0, key: 'live', label: 'live', text: 'text-status-in-progress' },
    { count: c.ready ?? 0, key: 'ready', label: 'ready', text: 'text-status-ready' },
    {
      count: c.under_review ?? 0,
      key: 'review',
      label: 'review',
      text: 'text-status-under-review',
    },
    { count: held, key: 'held', label: 'held', text: 'text-status-awaiting' },
  ];
  return items.filter((i) => i.count > 0);
}
