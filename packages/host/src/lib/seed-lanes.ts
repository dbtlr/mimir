import { SEED_KIND_VALUES, seedLane } from '@mimir/contract';
import type { SeedKind, SeedLane } from '@mimir/contract';

import type { EngineSeed } from '../api/browse-queries';
import type { WireSeed } from '../api/types';

/**
 * The seeds queue's lane grammar (MMR-247). Each seed's lane comes from the
 * contract's one classifier (MMR-245), which the CLI and the `/api` wire read
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

/** Group-header label per lane — sentence case; the group header uppercases it. */
export const SEED_LANE_LABEL: Record<SeedLane, string> = {
  parked: 'Parked',
  promoted: 'Promoted',
  ready: 'Ready to resolve',
  settled: 'Settled',
  untriaged: 'Untriaged',
};

/** Header ink per lane: teal untriaged, violet ready-to-resolve, neutral promoted,
 * the task status palette's parked ink for parked, ghost settled. */
export const SEED_LANE_INK: Record<SeedLane, string> = {
  parked: 'text-status-parked',
  promoted: 'text-ink-dim',
  ready: 'text-attention',
  settled: 'text-ink-ghost',
  untriaged: 'text-accent-foreground',
};

/**
 * What a seed's lane reads: its lifecycle and whether it is ready to resolve,
 * in either read's spelling (an Engine seed or an `/api` wire seed).
 */
export type SeedStanding = Pick<EngineSeed, 'lifecycle'> &
  (Pick<EngineSeed, 'readyToResolve'> | Pick<WireSeed, 'ready_to_resolve'>);

/** Whether a promoted seed's spawned work has all settled. */
export function isReadyToResolve(seed: SeedStanding): boolean {
  return 'readyToResolve' in seed ? seed.readyToResolve : seed.ready_to_resolve;
}

/** The seed's exclusive lane. */
export function laneOf(seed: SeedStanding): SeedLane {
  return seedLane({ lifecycle: seed.lifecycle, readyToResolve: isReadyToResolve(seed) });
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

/** Header summary: how many seeds await triage (untriaged) and resolution (ready). */
export function seedSummary(seeds: readonly EngineSeed[]): {
  toTriage: number;
  toResolve: number;
} {
  let toTriage = 0;
  let toResolve = 0;
  for (const s of seeds) {
    const lane = laneOf(s);
    if (lane === 'untriaged') {
      toTriage += 1;
    } else if (lane === 'ready') {
      toResolve += 1;
    }
  }
  return { toResolve, toTriage };
}

/** Whether a URL value is one of the seed kinds (`validateSearch` drops anything else). */
export function isSeedKind(value: unknown): value is SeedKind {
  return typeof value === 'string' && (SEED_KIND_VALUES as readonly string[]).includes(value);
}
