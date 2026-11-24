import { describe, expect, it } from 'vitest';

import { listSuccessor } from '../components/patterns/feed/card-list-model';

/*
 * Where focus goes when a card of the grouped card list leaves (ADR 0019,
 * MMR-723 refinement: The list's state), over the cards' one order across
 * sections. The component tests prove the list moves focus by it.
 */

describe('the successor of a card that left the list', () => {
  it('is the nearest card after it in the old order that is still there, across sections', () => {
    expect(
      listSuccessor({ after: ['a', 'd'], before: ['a', 'b', 'c', 'd'], holder: 'b', kept: null }),
    ).toStrictEqual({ key: 'b', successor: 'd' });
  });

  it('is the nearest card before it when none after it is left', () => {
    expect(
      listSuccessor({ after: ['a', 'b'], before: ['a', 'b', 'c', 'd'], holder: 'c', kept: null }),
    ).toStrictEqual({ key: 'c', successor: 'b' });
  });

  it('is the first card when no card that was on the page survives', () => {
    expect(
      listSuccessor({ after: ['x', 'y'], before: ['a', 'b', 'c'], holder: 'c', kept: null }),
    ).toStrictEqual({ key: 'c', successor: 'x' });
  });

  it('is nothing when no card is left, or when the holder stays', () => {
    expect(listSuccessor({ after: [], before: ['a'], holder: 'a', kept: null })).toBeNull();
    expect(listSuccessor({ after: ['a'], before: ['a', 'b'], holder: 'a', kept: null })).toBeNull();
  });

  it('keeps a successor already found while its card is still gone and the successor still there', () => {
    const kept = { key: 'b', successor: 'c' };
    expect(
      listSuccessor({ after: ['a', 'c', 'n'], before: ['a', 'c'], holder: null, kept }),
    ).toStrictEqual(kept);
  });

  it('moves on from a kept successor that left too, to the card after it', () => {
    expect(
      listSuccessor({
        after: ['a', 'd'],
        before: ['a', 'c', 'd'],
        holder: 'b',
        kept: { key: 'b', successor: 'c' },
      }),
    ).toStrictEqual({ key: 'b', successor: 'd' });
  });
});
