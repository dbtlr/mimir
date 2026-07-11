import type { SeedLane } from '@mimir/contract';

import type { WireSeed } from '../api/types';

/**
 * The seeds queue's lane grammar (MMR-247). The server serves each seed's
 * `lane` (MMR-245), so grouping never re-derives it — it only buckets and
 * orders. Order is fixed: UNTRIAGED → READY TO RESOLVE → PROMOTED → SETTLED
 * (the "dispose" wording the mocks predate is renamed to "resolve").
 */
export const SEED_LANE_ORDER: readonly SeedLane[] = ['untriaged', 'ready', 'promoted', 'settled'];

/** Mono microlabel per lane (the lane-header idiom). */
export const SEED_LANE_LABEL: Record<SeedLane, string> = {
  promoted: 'PROMOTED',
  ready: 'READY TO RESOLVE',
  settled: 'SETTLED',
  untriaged: 'UNTRIAGED',
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

/** SETTLED fold counts, split by terminal lifecycle (resolved vs rejected). */
export function settledCounts(settled: readonly WireSeed[]): {
  resolved: number;
  rejected: number;
} {
  let resolved = 0;
  let rejected = 0;
  for (const s of settled) {
    if (s.lifecycle === 'resolved') {
      resolved += 1;
    } else if (s.lifecycle === 'rejected') {
      rejected += 1;
    }
  }
  return { rejected, resolved };
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
