import { describe, expect, it } from 'vitest';

import {
  deckRange,
  keptSuccessor,
  pageCount,
  reconcileCurrent,
} from '../components/patterns/feed/deck-model';

/*
 * The Needs you deck's current card through a refetch (ADR 0019, MMR-721
 * refinement, "The deck's state"): one pure rule set, swept here once; the
 * component tests prove the deck calls it and moves focus by its result.
 */

const TEN = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('the current card through a refetch', () => {
  it('keeps the current card by identity when a refetch reorders the deck', () => {
    expect(
      reconcileCurrent({
        after: ['x', 'c', 'a', 'b'],
        anchor: null,
        before: ['a', 'b', 'c'],
        current: 'c',
        desktop: false,
      }),
    ).toBe('c');
  });

  it('makes the nearest later card that is still in the deck current when the current card leaves', () => {
    expect(
      reconcileCurrent({
        after: ['a', 'd', 'e'],
        anchor: null,
        before: ['a', 'b', 'c', 'd', 'e'],
        current: 'b',
        desktop: false,
      }),
    ).toBe('d');
  });

  it('falls back to the nearest earlier card when nothing after the current card is left', () => {
    expect(
      reconcileCurrent({
        after: ['a', 'x'],
        anchor: null,
        before: ['a', 'b', 'c', 'd'],
        current: 'c',
        desktop: false,
      }),
    ).toBe('a');
  });

  it('takes the new card at the old index, clamped, when no old card survives', () => {
    expect(
      reconcileCurrent({
        after: ['x', 'y', 'z'],
        anchor: null,
        before: ['a', 'b', 'c', 'd', 'e'],
        current: 'b',
        desktop: false,
      }),
    ).toBe('y');
    expect(
      reconcileCurrent({
        after: ['x', 'y'],
        anchor: null,
        before: ['a', 'b', 'c', 'd', 'e'],
        current: 'e',
        desktop: false,
      }),
    ).toBe('y');
  });

  it('has no current card once the deck is empty', () => {
    expect(
      reconcileCurrent({ after: [], anchor: 'a', before: ['a'], current: 'a', desktop: true }),
    ).toBeNull();
  });

  it('shows the page that holds an anchored desktop card wherever the refetch moves it', () => {
    // Card e sat on page 2 (index 4); two cards before it left, so page 1 holds it now.
    expect(
      reconcileCurrent({
        after: ['a', 'd', 'e', 'f', 'g', 'h'],
        anchor: 'e',
        before: TEN.slice(0, 8),
        current: 'e',
        desktop: true,
      }),
    ).toBe('e');
  });

  it('keeps an unanchored desktop page and makes its refilled first card current', () => {
    // Page 2 began at e; card b left, so page 2 now begins at f.
    expect(
      reconcileCurrent({
        after: TEN.filter((key) => key !== 'b'),
        anchor: null,
        before: TEN,
        current: 'e',
        desktop: true,
      }),
    ).toBe('f');
  });

  it('turns an unanchored desktop deck back a page when its last page empties', () => {
    expect(
      reconcileCurrent({
        after: ['a', 'b', 'c', 'd'],
        anchor: null,
        before: ['a', 'b', 'c', 'd', 'e'],
        current: 'e',
        desktop: true,
      }),
    ).toBe('a');
  });

  it('follows an anchored desktop card that left to its successor', () => {
    expect(
      reconcileCurrent({
        after: TEN.filter((key) => key !== 'd'),
        anchor: 'd',
        before: TEN,
        current: 'd',
        desktop: true,
      }),
    ).toBe('e');
  });
});

describe('the successor kept for a dialog’s return', () => {
  it('keeps the new current card for the card holding focus when it leaves', () => {
    expect(
      keptSuccessor({
        after: ['a', 'c'],
        before: ['a', 'b', 'c'],
        current: 'c',
        holder: 'b',
        kept: null,
      }),
    ).toStrictEqual({ key: 'b', successor: 'c' });
  });

  it('keeps none for a card that leaves while it holds no focus', () => {
    expect(
      keptSuccessor({
        after: ['a', 'c'],
        before: ['a', 'b', 'c'],
        current: 'c',
        holder: 'a',
        kept: null,
      }),
    ).toBeNull();
    expect(
      keptSuccessor({
        after: ['a', 'c'],
        before: ['a', 'b', 'c'],
        current: 'c',
        holder: null,
        kept: null,
      }),
    ).toBeNull();
  });

  it('keeps none when no card remains to succeed it', () => {
    expect(
      keptSuccessor({ after: [], before: ['a'], current: null, holder: 'a', kept: null }),
    ).toBeNull();
  });

  it('keeps a successor through a later refetch while its successor stays', () => {
    const kept = { key: 'b', successor: 'c' };
    expect(
      keptSuccessor({
        after: ['c', 'd'],
        before: ['a', 'c', 'd'],
        current: 'c',
        holder: 'b',
        kept,
      }),
    ).toBe(kept);
  });

  it('drops a successor that left, or whose card came back', () => {
    const kept = { key: 'b', successor: 'c' };
    expect(
      keptSuccessor({
        after: ['a', 'd'],
        before: ['a', 'c', 'd'],
        current: 'd',
        holder: 'b',
        kept,
      }),
    ).toBeNull();
    expect(
      keptSuccessor({
        after: ['a', 'b', 'c'],
        before: ['a', 'c'],
        current: 'c',
        holder: 'b',
        kept,
      }),
    ).toBeNull();
  });
});

describe('paging', () => {
  it('counts pages of four, at least one', () => {
    expect([0, 1, 4, 5, 8, 9, 120].map((count) => pageCount(count))).toStrictEqual([
      1, 1, 1, 2, 2, 3, 30,
    ]);
  });

  it('names a page by its first and last card, the last page short', () => {
    expect(deckRange({ count: 10, page: 0 })).toStrictEqual({ first: 1, last: 4 });
    expect(deckRange({ count: 10, page: 2 })).toStrictEqual({ first: 9, last: 10 });
  });
});
