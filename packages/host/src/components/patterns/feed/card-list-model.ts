import { successorOf } from './deck-model';
import type { KeptSuccessor } from './deck-model';

/*
 * The grouped card list's rule for where focus goes when a card leaves (ADR
 * 0019, MMR-723 refinement: The list's state), over the cards' one order
 * across sections. Unlike the deck, the list has no current card: focus from
 * a card that left goes to its successor, and with no old card left, to the
 * first card.
 */

/**
 * The card that takes the place of `holder` once a refetch turns `before`
 * into `after`: the nearest card after it in the old order still on the page,
 * else the nearest before it, else the first card. `holder` is the card that
 * holds focus, in itself, its preview, or a dialog opened from it, or whose
 * dialog is open. A successor already `kept` for a card stays while that card
 * is gone and the successor is still there; when the successor leaves too,
 * the rule runs again from it.
 */
export function listSuccessor({
  before,
  after,
  holder,
  kept,
}: {
  before: readonly string[];
  after: readonly string[];
  holder: string | null;
  kept: KeptSuccessor | null;
}): KeptSuccessor | null {
  const remaining = new Set(after);
  const key = holder ?? kept?.key ?? null;
  if (key === null || remaining.has(key)) {
    return null;
  }
  // The card whose place is taken: the holder itself, or the successor kept for it.
  const from = kept?.key === key && !before.includes(key) ? kept.successor : key;
  if (remaining.has(from)) {
    return { key, successor: from };
  }
  const left = before.indexOf(from);
  const successor =
    (left === -1 ? undefined : successorOf({ after: remaining, before, left })) ?? after[0];
  return successor === undefined ? null : { key, successor };
}
