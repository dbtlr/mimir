import { SEED_KIND_VALUES } from '@mimir/contract';
import type { SeedKind, SeedLane } from '@mimir/contract';

import type { WireSeed } from '../api/types';

/**
 * The seeds queue's lane grammar (MMR-247). The server serves each seed's
 * `lane` (MMR-245), so grouping never re-derives it — it only buckets and
 * orders. Order is fixed: UNTRIAGED → READY TO RESOLVE → PROMOTED → SETTLED
 * (the "dispose" wording the mocks predate is renamed to "resolve").
 */
export const SEED_LANE_ORDER: readonly SeedLane[] = ['untriaged', 'ready', 'promoted', 'settled'];

/** Group-header label per lane — sentence case; the group header uppercases it. */
export const SEED_LANE_LABEL: Record<SeedLane, string> = {
  promoted: 'Promoted',
  ready: 'Ready to resolve',
  settled: 'Settled',
  untriaged: 'Untriaged',
};

/** Header ink per lane: teal untriaged, violet ready-to-resolve, neutral promoted, ghost settled. */
export const SEED_LANE_INK: Record<SeedLane, string> = {
  promoted: 'text-ink-dim',
  ready: 'text-attention',
  settled: 'text-ink-ghost',
  untriaged: 'text-accent-foreground',
};

export type SeedLaneGroup = {
  lane: SeedLane;
  seeds: WireSeed[];
};

/**
 * Bucket seeds into the four lanes in fixed order. Empty lanes are dropped —
 * a lane with no seeds shows no header. Within a lane the server's array order
 * (FIFO by creation) is preserved.
 */
export function groupSeedsByLane(seeds: readonly WireSeed[]): SeedLaneGroup[] {
  const groups: SeedLaneGroup[] = [];
  for (const lane of SEED_LANE_ORDER) {
    const inLane = seeds.filter((s) => s.lane === lane);
    if (inLane.length > 0) {
      groups.push({ lane, seeds: inLane });
    }
  }
  return groups;
}

/** Whether a seed matches a search query: id, title, or lede, case-insensitive. */
export function seedMatchesQuery(seed: WireSeed, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return [seed.id, seed.title, seed.lede ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** Header summary: how many seeds await triage (untriaged) and resolution (ready). */
export function seedSummary(seeds: readonly WireSeed[]): { toTriage: number; toResolve: number } {
  let toTriage = 0;
  let toResolve = 0;
  for (const s of seeds) {
    if (s.lane === 'untriaged') {
      toTriage += 1;
    } else if (s.lane === 'ready') {
      toResolve += 1;
    }
  }
  return { toResolve, toTriage };
}

/** Whether a URL value is one of the seed kinds (`validateSearch` drops anything else). */
export function isSeedKind(value: unknown): value is SeedKind {
  return typeof value === 'string' && (SEED_KIND_VALUES as readonly string[]).includes(value);
}
