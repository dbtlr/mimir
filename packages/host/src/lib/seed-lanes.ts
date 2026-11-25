import { seedLane } from '@mimir/contract';
import type { SeedLane } from '@mimir/contract';

import type { EngineSeed } from '../api/browse-queries';

/**
 * The seeds queue's lane grammar (MMR-247). Each seed's lane comes from the
 * contract's one classifier (MMR-245), which the CLI reads
 * too, so grouping never invents its own rule — it only buckets and orders.
 * Order is fixed: UNTRIAGED → READY TO RESOLVE → PROMOTED → PARKED → SETTLED
 * (the "dispose" wording the mocks predate is renamed to "resolve").
 */
export const SEED_LANE_ORDER: readonly SeedLane[] = [
  'untriaged',
  'ready',
  'promoted',
  'parked',
  'settled',
];

/** Each lane's name, the Seeds list's group heads and folds (MMR-725). */
export const SEED_LANE_LABEL: Record<SeedLane, string> = {
  parked: 'Parked',
  promoted: 'Promoted',
  ready: 'Ready to resolve',
  settled: 'Settled',
  untriaged: 'To triage',
};

/** A lane's dot: the lane's hue sits on the dot, and its word reads in bright ink (MMR-718). */
export const SEED_LANE_DOT: Record<SeedLane, string> = {
  parked: 'bg-status-parked',
  promoted: 'bg-ink-dim',
  ready: 'bg-attention',
  settled: 'bg-ink-faint',
  untriaged: 'bg-accent',
};

/** What a seed's lane reads: its lifecycle and whether it is ready to resolve. */
export type SeedStanding = Pick<EngineSeed, 'lifecycle' | 'readyToResolve'>;

/** The seed's exclusive lane. */
export function laneOf(seed: SeedStanding): SeedLane {
  return seedLane({ lifecycle: seed.lifecycle, readyToResolve: seed.readyToResolve });
}

export type SeedLaneGroup = {
  lane: SeedLane;
  seeds: EngineSeed[];
};

/**
 * Bucket seeds into the lanes in fixed order. Empty lanes are dropped —
 * a lane with no seeds shows no header. Within a lane the server's array order
 * (FIFO by creation) is preserved.
 */
export function groupSeedsByLane(seeds: readonly EngineSeed[]): SeedLaneGroup[] {
  const groups: SeedLaneGroup[] = [];
  for (const lane of SEED_LANE_ORDER) {
    const inLane = seeds.filter((s) => laneOf(s) === lane);
    if (inLane.length > 0) {
      groups.push({ lane, seeds: inLane });
    }
  }
  return groups;
}

/** Whether a seed matches a search query: id, title, or lede, case-insensitive. */
export function seedMatchesQuery(seed: EngineSeed, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return [seed.id, seed.title, seed.lede ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
