import { useImperativeHandle, useMemo, useRef } from 'react';
import type { Ref } from 'react';

import type { ReviewReport } from '../api/view-queries';
import { needsYouSections } from './needs-you-deck-model';
import type { NeedsYouCard } from './needs-you-deck-model';
import { needsYouContent, needsYouPreview, useNeedsYouActions } from './needs-you-cards';
import type { NeedsYouWrites } from './needs-you-cards';
import { FeedCardList } from './patterns/feed/card-list';
import type { FeedCardListHandle, ListSection } from './patterns/feed/card-list';

/*
 * The needs-you set as the Needs you page lists it (ADR 0019, MMR-723
 * refinement): the deck's cards in one feed section per project, each headed
 * by the project's name and "N cards, M items". The cards act through the
 * same mapping as the deck's (`needs-you-cards.tsx`); a bundle's button
 * carries its return-target name, so a walkthrough's return finds it in the
 * document. Its writes come in through `writes`, as the deck's do.
 */

/** `1 card` / `2 cards`: a count with its noun, singular at one. */
export function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : `${noun}s`}`;
}

/** What the page asks of its list: the quiet line's focus, once the bar left with the last card. */
export type NeedsYouListHandle = Pick<FeedCardListHandle, 'focusQuiet'>;

export function NeedsYouListView({
  report,
  writes,
  offline = false,
  ref,
}: {
  report: ReviewReport;
  writes: NeedsYouWrites;
  offline?: boolean;
  ref?: Ref<NeedsYouListHandle>;
}) {
  const sections = useMemo(() => needsYouSections(report), [report]);
  const cards = useMemo(() => sections.flatMap((section) => section.cards), [sections]);
  const list = useRef<FeedCardListHandle>(null);
  const { actionOf, answerDialog } = useNeedsYouActions({
    cards,
    namedReturns: true,
    offline,
    restoreFocus: (key) => {
      list.current?.restoreFocus(key);
    },
    writes,
  });
  useImperativeHandle(ref, () => ({
    focusQuiet: () => {
      list.current?.focusQuiet();
    },
  }));

  const listSections: ListSection[] = sections.map((section) => ({
    cards: section.cards.map((card) => ({
      action: actionOf(card),
      card: needsYouContent(card),
      key: card.key,
      previewKey: card.key,
    })),
    count: `${counted(section.cards.length, 'card')}, ${counted(section.records, 'item')}`,
    key: section.key,
    title: section.name,
  }));
  const previews = new Map<string, NeedsYouCard>(cards.map((card) => [card.key, card]));

  return (
    <>
      <FeedCardList
        ref={list}
        sections={listSections}
        preview={(key) => {
          const card = previews.get(key);
          return card === undefined ? undefined : needsYouPreview(card);
        }}
        quiet="Nothing needs you."
        offline={offline}
      />
      {answerDialog}
    </>
  );
}
