import type { SeedLane, SeedView } from '@mimir/contract';

import { isTerminalSeed } from './store';

/**
 * Classify a seed view into its exclusive {@link SeedLane} (MMR-245) — the seed
 * sibling of the node attention-lane classifier. Highest-wins: a `promoted` seed
 * that is ready-to-resolve reads as `ready` (precedence over the plain `promoted`
 * lane), so the attention signal is never buried; a terminal seed is `settled`
 * (derived from {@link isTerminalSeed}, not a hand-spelled union). The single
 * source both the CLI lane view and the wire (`seedToWire`) consume, so the web UI
 * and MMR-246 derive nothing.
 */
export function seedLane(view: Pick<SeedView, 'lifecycle' | 'readyToResolve'>): SeedLane {
  if (isTerminalSeed(view.lifecycle)) {
    return 'settled';
  }
  if (view.lifecycle === 'new') {
    return 'untriaged';
  }
  // promoted: ready-to-resolve wins over the plain promoted lane.
  return view.readyToResolve ? 'ready' : 'promoted';
}
