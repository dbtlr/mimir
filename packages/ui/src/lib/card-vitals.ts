import type { Distribution, StatusWord } from '@mimir/contract';

/**
 * The project card's vitals (MMR-106) — the five actionable-state leaf counts
 * (from MMR-105's `leaf_counts` facet) the card surfaces, in a fixed order that
 * mirrors the page's bands: review → in prog → ready → await → blocked. Blocked
 * earns its place so an all-blocked project doesn't read as all-zero. The other
 * leaf buckets (parked/done/abandoned/new) are deliberately not surfaced.
 */

export type Vital = {
  word: StatusWord;
  label: string;
  count: number;
};

const VITAL_ORDER: readonly { word: StatusWord; label: string }[] = [
  { label: 'review', word: 'under_review' },
  { label: 'in prog', word: 'in_progress' },
  { label: 'ready', word: 'ready' },
  { label: 'await', word: 'awaiting' },
  { label: 'blocked', word: 'blocked' },
];

export function cardVitals(counts: Distribution | undefined): Vital[] {
  return VITAL_ORDER.map(({ word, label }) => ({ count: counts?.[word] ?? 0, label, word }));
}
