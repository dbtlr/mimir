import { expect, test } from 'bun:test';

import { SEED_LIFECYCLE_VALUES, seedLane } from '@mimir/contract';

import { isTerminalSeed } from './store';

test('a seed is settled exactly when the seed machine calls its lifecycle terminal', () => {
  for (const lifecycle of SEED_LIFECYCLE_VALUES) {
    for (const readyToResolve of [false, true]) {
      expect(seedLane({ lifecycle, readyToResolve }) === 'settled').toBe(isTerminalSeed(lifecycle));
    }
  }
});
