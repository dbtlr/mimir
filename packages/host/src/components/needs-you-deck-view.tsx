import { useMemo, useRef } from 'react';

import type { ReviewReport } from '../api/view-queries';
import { scopeCards } from '../lib/scoped-work';
import { useReturnTargetResolver } from '../lib/walkthrough-mark';
import { needsYouContent, needsYouPreview, useNeedsYouActions } from './needs-you-cards';
import type { NeedsYouWrites } from './needs-you-cards';
import { needsYouCards } from './needs-you-deck-model';
import { FeedDeck } from './patterns/feed/deck';
import type { DeckCard, FeedDeckHandle } from './patterns/feed/deck';
import type { FeedLink } from './patterns/feed/link';

/*
 * The Needs you deck over the review report (ADR 0019, MMR-721 refinement):
 * the cards `needsYouCards` maps, drawn and acted on as `needs-you-cards.tsx`
 * maps them, and the walkthrough's return. Its two writes come in through
 * `writes`, so /kit and the Chromium harness run it without the console's
 * server functions; `NeedsYouDeck` (needs-you-deck.tsx) passes the console's own.
 */

export function NeedsYouDeckView({
  report,
  writes,
  offline = false,
  seeAll,
  countItems = false,
  scope,
  quiet = 'Nothing needs you.',
  className,
}: {
  report: ReviewReport;
  writes: NeedsYouWrites;
  offline?: boolean;
  seeAll?: FeedLink;
  /** The head counts the set's records beside the cards, as the top-bar alert counts them (Home, MMR-722). */
  countItems?: boolean;
  /**
   * Keep the cards that hold one of these records, a scoped page's needs-you
   * set by ID (MMR-727); a bundle shows whole when any of its decisions is here.
   */
  scope?: readonly string[];
  /** The line that takes the deck's place when it has no card. */
  quiet?: string;
  className?: string;
}) {
  const cards = useMemo(
    () => (scope === undefined ? needsYouCards(report) : scopeCards(needsYouCards(report), scope)),
    [report, scope],
  );
  const deck = useRef<FeedDeckHandle>(null);
  const { actionOf, answerDialog } = useNeedsYouActions({
    cards,
    offline,
    restoreFocus: (key) => {
      deck.current?.restoreFocus(key);
    },
    writes,
  });

  // A walkthrough's return asks the deck for a bundle before it queries the page. The shell
  // asks while React is still committing the page, so the turn, which renders at once, waits a
  // microtask, and answers with whether the deck held the card.
  const bundles = useMemo(
    () => new Set(cards.filter((card) => card.action?.kind === 'review').map((card) => card.key)),
    [cards],
  );
  const turnAfterCommit = async (entry: string): Promise<boolean> => {
    await Promise.resolve();
    return deck.current?.turnTo(entry) ?? false;
  };
  useReturnTargetResolver((entry) => (bundles.has(entry) ? turnAfterCommit(entry) : false));

  const deckCards: DeckCard[] = cards.map((card) => ({
    action: actionOf(card),
    card: needsYouContent(card),
    key: card.key,
    previewKey: card.key,
  }));
  const previews = new Map(cards.map((card) => [card.key, card]));

  return (
    <>
      <FeedDeck
        ref={deck}
        title="Needs you"
        seeAll={seeAll}
        cards={deckCards}
        items={countItems ? report.queue.length : undefined}
        preview={(key) => {
          const card = previews.get(key);
          return card === undefined ? undefined : needsYouPreview(card);
        }}
        quiet={quiet}
        offline={offline}
        className={className}
      />
      {answerDialog}
    </>
  );
}
