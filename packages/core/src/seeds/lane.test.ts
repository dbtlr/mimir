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

test('each live lifecycle has its own lane, and ready-to-resolve outranks promoted', () => {
  expect(seedLane({ lifecycle: 'new', readyToResolve: false })).toBe('untriaged');
  expect(seedLane({ lifecycle: 'parked', readyToResolve: false })).toBe('parked');
  expect(seedLane({ lifecycle: 'promoted', readyToResolve: false })).toBe('promoted');
  expect(seedLane({ lifecycle: 'promoted', readyToResolve: true })).toBe('ready');
});
