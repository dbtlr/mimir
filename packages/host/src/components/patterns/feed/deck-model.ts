/*
 * The Needs you deck's rules for which card is current (ADR 0019, MMR-721
 * refinement, "The deck's state"), as pure functions over card identities.
 * The deck holds one current card; the phone shows it, and desktop shows the
 * page that holds it, so the page is always `pageOf` the current card's index.
 */

/** Cards on a desktop page. */
export const DECK_PAGE = 4;

/** The page, counted from 0, that holds the card at `index`. */
export function pageOf(index: number): number {
  return Math.floor(index / DECK_PAGE);
}

/** How many desktop pages `count` cards fill; an empty deck still counts one. */
export function pageCount(count: number): number {
  return Math.max(1, Math.ceil(count / DECK_PAGE));
}

/** A desktop page's first and last card, counted from 1, for its range ("5–8 of 10"). */
export function deckRange({ count, page }: { count: number; page: number }): {
  first: number;
  last: number;
} {
  const first = page * DECK_PAGE + 1;
  return { first, last: Math.min(count, first + DECK_PAGE - 1) };
}

/**
 * The card that takes a leaving card's place: the nearest card after it in
 * the old order still in the deck, or with none after it, the nearest before.
 */
function successorOf({
  before,
  left,
  after,
}: {
  before: readonly string[];
  left: number;
  after: ReadonlySet<string>;
}): string | undefined {
  return (
    before.slice(left + 1).find((key) => after.has(key)) ??
    before
      .slice(0, Math.max(0, left))
      .toReversed()
      .find((key) => after.has(key))
  );
}

/**
 * The current card after a refetch turns `before` into `after`. `anchor` is
 * the card that holds focus, or else the card whose preview is open; on
 * desktop an anchored deck shows the page that holds its anchor, and an
 * unanchored one keeps its page number, clamped, and makes its first card
 * current. When the current card leaves, its successor is current; when no
 * old card survives, the new card at its old index, clamped, is.
 */
export function reconcileCurrent({
  before,
  after,
  current,
  anchor,
  desktop,
}: {
  before: readonly string[];
  after: readonly string[];
  current: string | null;
  anchor: string | null;
  desktop: boolean;
}): string | null {
  const last = after.at(-1);
  if (last === undefined) {
    return null;
  }
  const oldIndex = current === null ? 0 : Math.max(0, before.indexOf(current));
  if (desktop && anchor === null) {
    const page = Math.min(pageOf(oldIndex), pageCount(after.length) - 1);
    return after[page * DECK_PAGE] ?? last;
  }
  const followed = desktop ? anchor : current;
  if (followed !== null && after.includes(followed)) {
    return followed;
  }
  const leftIndex = followed === null ? oldIndex : before.indexOf(followed);
  return (
    successorOf({ after: new Set(after), before, left: leftIndex }) ??
    after[Math.min(leftIndex, after.length - 1)] ??
    last
  );
}

/** A card that left and the card its dialog's return goes to instead. */
export type KeptSuccessor = { key: string; successor: string };

/**
 * The successor a dialog's return (`restoreFocus`) may need after a refetch
 * turns `before` into `after`. Only the card holding focus, in itself, its
 * preview, or a dialog opened from it, can need one: when it leaves, the new
 * `current` card is its successor. One already `kept` stays while its card
 * is still gone and its successor still in the deck; otherwise the return
 * follows the current card, so nothing is kept.
 */
export function keptSuccessor({
  before,
  after,
  current,
  holder,
  kept,
}: {
  before: readonly string[];
  after: readonly string[];
  current: string | null;
  holder: string | null;
  kept: KeptSuccessor | null;
}): KeptSuccessor | null {
  const remaining = new Set(after);
  if (holder !== null && current !== null && !remaining.has(holder) && before.includes(holder)) {
    return { key: holder, successor: current };
  }
  if (kept !== null && !remaining.has(kept.key) && remaining.has(kept.successor)) {
    return kept;
  }
  return null;
}
