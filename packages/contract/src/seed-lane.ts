import type { SeedLane, SeedLifecycle } from './enums';

/**
 * Classify a seed into its exclusive {@link SeedLane} (MMR-245), highest-wins:
 * a terminal seed (`resolved`, `rejected`) is `settled`, and a promoted seed
 * whose spawned work has all settled is `ready` rather than `promoted`, so the
 * attention signal is never buried. The one classifier the CLI lane view
 * and the console both read, so no consumer derives its own.
 */
export function seedLane(seed: { lifecycle: SeedLifecycle; readyToResolve: boolean }): SeedLane {
  switch (seed.lifecycle) {
    case 'resolved':
    case 'rejected': {
      return 'settled';
    }
    case 'new': {
      return 'untriaged';
    }
    case 'parked': {
      return 'parked';
    }
    default: {
      return seed.readyToResolve ? 'ready' : 'promoted';
    }
  }
}
