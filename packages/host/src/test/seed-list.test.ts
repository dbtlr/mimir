import type { SeedLane } from '@mimir/contract';
import { describe, expect } from 'vitest';

import type { EngineSeed } from '../api/browse-queries';
import { SEED_LANE_ORDER } from '../lib/seed-lanes';
import { seedCountLine, seedKinds } from '../lib/seed-list';
import { seedIn } from './browse-fixtures';

/** `n` seeds in each lane named. */
const board = (counts: Partial<Record<SeedLane, number>>): EngineSeed[] =>
  SEED_LANE_ORDER.flatMap((lane) => Array.from({ length: counts[lane] ?? 0 }, () => seedIn(lane)));

describe('the Seeds count line (MMR-725)', () => {
  it('leads with the open seeds and breaks down every open lane, so the parts sum', () => {
    const seeds = board({ parked: 15, promoted: 15, ready: 2, settled: 90, untriaged: 11 });
    expect(seedCountLine(seeds, undefined)).toBe(
      '43 open seeds: 11 to triage, 2 ready to resolve, 15 promoted, 15 parked',
    );
  });

  it('leaves out an empty lane, and is singular at one', () => {
    expect(seedCountLine(board({ untriaged: 1 }), undefined)).toBe('1 open seed: 1 to triage');
  });

  it('says when only settled seeds remain, and when there are none', () => {
    expect(seedCountLine(board({ settled: 3 }), undefined)).toBe('No open seeds');
    expect(seedCountLine([], undefined)).toBe('No seeds');
  });

  it.each([
    ['to-triage', '11 seeds to triage', '1 seed to triage', 'No seeds to triage'],
    [
      'ready-to-resolve',
      '11 seeds ready to resolve',
      '1 seed ready to resolve',
      'No seeds ready to resolve',
    ],
    ['parked', '11 parked seeds', '1 parked seed', 'No parked seeds'],
    ['settled', '11 settled seeds', '1 settled seed', 'No settled seeds'],
  ] as const)('counts the %s view in its own words', (show, many, one, none) => {
    const lane = {
      parked: 'parked',
      'ready-to-resolve': 'ready',
      settled: 'settled',
      'to-triage': 'untriaged',
    } as const;
    expect(seedCountLine(board({ [lane[show]]: 11, promoted: 4 }), show)).toBe(many);
    expect(seedCountLine(board({ [lane[show]]: 1 }), show)).toBe(one);
    expect(seedCountLine(board({ promoted: 4 }), show)).toBe(none);
  });
});

describe('the kind a Seeds URL carries', () => {
  it('reads a comma list of kinds in order, dropping words that name none', () => {
    expect(seedKinds('feature,epic,bug,bug')).toStrictEqual(['feature', 'bug']);
    expect(seedKinds(undefined)).toStrictEqual([]);
  });
});
