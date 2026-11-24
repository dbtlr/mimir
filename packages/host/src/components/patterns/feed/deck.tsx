import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentProps, KeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { flushSync } from 'react-dom';

import { cn } from '../../../lib/cn';
import { useDrawerSide } from '../../ui/drawer';
import { SwipeTrack } from '../../ui/swipe-track';
import { FeedCard } from './card';
import { cardElement, useCardActions } from './card-actions';
import type { CardAction, CardPress, CardWrite } from './card-actions';
import { cardButton } from './card-button';
import { CardGrid } from './card-grid';
import {
  DECK_PAGE,
  deckRange,
  keptSuccessor,
  pageCount,
  pageOf,
  reconcileCurrent,
} from './deck-model';
import type { KeptSuccessor } from './deck-model';
import { DesktopPager, PhonePager } from './deck-pager';
import type { DeckTurn } from './deck-pager';
import { FeedPreview, useFeedPreviewControl } from './feed-preview';
import type { FeedLink } from './link';
import type { Preview } from './preview-panel';
import { Quiet } from './quiet';
import { SectionHead } from './section-head';

/*
 * The Needs you deck (ADR 0019, MMR-721 refinement; DESIGN.md, Needs you
 * deck): a ranked list of feed cards, one at a time below `md` with the next
 * card peeking, and pages of four in the Card grid from `md`. It holds one
 * current card by identity through turns, refetches, previews, and a
 * crossing of 768, and moves focus only when the element holding it goes.
 */

/** A card's content: the feed card's own fields, less what the deck supplies. */
export type DeckCardContent = Omit<ComponentProps<typeof FeedCard>, 'previewKey' | 'action'>;

/** A write's progress (`CardWrite`), as the deck's cards report it. */
export type DeckWrite = CardWrite;

/** A press on a card's action (`CardPress`). */
export type DeckPress = CardPress;

/** A card's one action (`CardAction`). */
export type DeckAction = CardAction;

/** One card in the deck: its identity (never its index), its content, and its preview's key. */
export type DeckCard = {
  key: string;
  previewKey: string;
  card: DeckCardContent;
  action?: DeckAction;
};

/** What a feature asks of the deck from outside it. */
export type FeedDeckHandle = {
  /**
   * Turns the deck to the card at once and focuses its button, or its
   * stretched target when it has none, as a walkthrough's return does.
   * Returns `false`, moving nothing, when the card is not in the deck.
   */
  turnTo: (key: string) => boolean;
  /**
   * Resolves focus after a dialog opened from the card closes: its button,
   * else its target; once it has left, its successor's target, or the
   * current card's when the successor has left too; with no card left, the
   * quiet line. A successor serves one return.
   */
  restoreFocus: (key: string) => void;
};

export type FeedDeckProps = {
  title: string;
  seeAll?: FeedLink;
  /** The cards in the deck's order. */
  cards: readonly DeckCard[];
  /** A card's preview, by its `previewKey`; the deck adds the card's action. */
  preview: (previewKey: string) => Omit<Preview, 'action'> | undefined;
  /** The quiet line that takes the section's place when no card remains. */
  quiet: string;
  /**
   * The records the cards hold, when the head counts them beside the cards
   * ("10 cards, 26 items", MMR-722); without it the head counts cards alone.
   */
  items?: number;
  /** Offline, a card's writes are `aria-disabled` (ADR 0013 §5). */
  offline?: boolean;
  className?: string;
  ref?: Ref<FeedDeckHandle>;
};

/** How much of the next phone card peeks, and the gap before it, in px. */
const PEEK = 38;
const GAP = 8;

/** Where each card of a held desktop page sits, so every page overlays the same two rows. */
const SLOT = [
  'row-start-1 col-start-1',
  'row-start-2 col-start-1 md:@min-[612px]:row-start-1 md:@min-[612px]:col-start-2',
  'row-start-3 col-start-1 md:@min-[612px]:row-start-2 md:@min-[612px]:col-start-1',
  'row-start-4 col-start-1 md:@min-[612px]:row-start-2 md:@min-[612px]:col-start-2',
] as const;

const TARGET = '[data-slot="feed-card-target"]';
const PANEL = '[data-slot="drawer-content"]';

/** The attribute that carries a deck card's identity. */
const IDENTITY = 'data-deck-card';

/** The deck's card element for an identity. */
function deckCard(root: HTMLElement | null, key: string): HTMLElement | null {
  return cardElement(root, IDENTITY, key);
}

export function FeedDeck({ cards, preview, offline = false, ref, ...rest }: FeedDeckProps) {
  const root = useRef<HTMLElement | null>(null);
  const quietLine = useRef<HTMLParagraphElement>(null);
  const actions = useCardActions({ cards, identity: IDENTITY, offline, preview, root });

  return (
    <FeedPreview
      preview={actions.preview}
      fallbackFocus={() =>
        root.current?.querySelector<HTMLElement>(`[data-current] ${TARGET}`) ?? quietLine.current
      }
    >
      <DeckBody
        {...rest}
        cards={cards}
        actionOf={actions.button}
        dialogCard={actions.dialogCard}
        onDialogReturn={(key) => {
          actions.dialogReturned(key);
        }}
        handle={ref}
        root={root}
        quietLine={quietLine}
      />
    </FeedPreview>
  );
}

/**
 * Sets `--deck-bleed` on the section to the room between its right edge and
 * the screen's, the page's right gutter whatever it is, so the phone deck
 * runs to the screen's edge (DESIGN.md, Needs you deck, Layout).
 */
function useBleedToScreenEdge(root: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const section = root.current;
    if (!active || section === null) {
      return undefined;
    }
    const measure = () => {
      const room = document.documentElement.clientWidth - section.getBoundingClientRect().right;
      section.style.setProperty('--deck-bleed', `${String(Math.max(0, room))}px`);
    };
    measure();
    globalThis.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(section);
    return () => {
      globalThis.removeEventListener('resize', measure);
      observer?.disconnect();
      section.style.removeProperty('--deck-bleed');
    };
  }, [active, root]);
}

/** Who holds focus in or for the deck, so focus can move on when that element goes. */
type FocusOwner =
  | { kind: 'card'; key: string; element: Element }
  | { kind: 'preview'; key: string; element: Element }
  | { kind: 'dialog'; key: string; element: Element }
  | { kind: 'control'; element: Element };

/** `1 card` / `2 cards`: a count with its noun, singular at one. */
const counted = (n: number, noun: string): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? noun : `${noun}s`}`;

function DeckBody({
  title,
  seeAll,
  items,
  cards: incoming,
  quiet,
  className,
  actionOf,
  dialogCard,
  onDialogReturn,
  handle,
  root,
  quietLine,
}: Omit<FeedDeckProps, 'preview' | 'offline' | 'ref'> & {
  actionOf: (card: DeckCard) => ReactNode;
  dialogCard: string | null;
  onDialogReturn: (key: string) => void;
  handle: Ref<FeedDeckHandle> | undefined;
  root: RefObject<HTMLElement | null>;
  quietLine: RefObject<HTMLParagraphElement | null>;
}) {
  const headingId = useId();
  const desktop = useDrawerSide() === 'right';
  const { openKey, modal, close } = useFeedPreviewControl();
  // A refetch that arrives during a swipe applies once the swipe settles.
  const [duringDrag, setDuringDrag] = useState<readonly DeckCard[] | null>(null);
  const cards = duringDrag ?? incoming;
  const keys = useMemo(() => cards.map((card) => card.key), [cards]);
  const signature = keys.join('\n');
  const openCard = cards.find((card) => card.previewKey === openKey)?.key ?? null;

  const [current, setCurrent] = useState<string | null>(keys[0] ?? null);
  const [focusCard, setFocusCard] = useState<string | null>(null);
  const [instant, setInstant] = useState(false);
  const [seen, setSeen] = useState({ keys, open: openCard, signature });
  // The successor a dialog's return needs once its card has left (`restoreFocus`).
  const [departed, setDeparted] = useState<KeptSuccessor | null>(null);
  const [announcement, setAnnouncement] = useState({ count: 0, text: '' });
  const announce = (text: string) => {
    setAnnouncement((last) => ({ count: last.count + 1, text }));
  };

  // A refetch: apply it by identity (deck-model.ts).
  if (seen.signature !== signature) {
    const anchor = focusCard ?? (desktop ? seen.open : null);
    const next = reconcileCurrent({ after: keys, anchor, before: seen.keys, current, desktop });
    // The card holding focus, or else the one whose dialog is open.
    const holder = focusCard ?? dialogCard;
    setDeparted((kept) => keptSuccessor({ after: keys, before: seen.keys, holder, kept }));
    setSeen({ keys, open: openCard, signature });
    setCurrent(next);
    setInstant(false);
    const before = current === null ? -1 : seen.keys.indexOf(current);
    const after = next === null ? -1 : keys.indexOf(next);
    if (desktop && next !== null && before !== -1 && pageOf(before) !== pageOf(after)) {
      const { first, last } = deckRange({ count: keys.length, page: pageOf(after) });
      announce(`${String(first)}–${String(last)} of ${String(keys.length)}`);
    }
  } else if (seen.open !== openCard) {
    // Opening or switching a preview makes its card current.
    setSeen({ ...seen, open: openCard });
    if (openCard !== null) {
      setCurrent(openCard);
    }
  }

  const index = Math.max(0, current === null ? 0 : keys.indexOf(current));
  const page = pageOf(index);
  const pages = pageCount(keys.length);
  const sheetOpen = modal && openKey !== null;

  const owner = useRef<FocusOwner | null>(null);
  const openCardNow = useRef(openCard);
  useEffect(() => {
    openCardNow.current = openCard;
  });

  // Who holds focus: a card (which makes it current), a deck control, the
  // open preview, or a dialog opened from a card. Anything else lets go.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const { target } = event;
      if (!(target instanceof Element)) {
        return;
      }
      const deck = root.current;
      const held = owner.current;
      const card = target.closest<HTMLElement>('[data-deck-card]');
      if (deck?.contains(target) === true) {
        const key = card?.dataset.deckCard;
        if (key === undefined) {
          owner.current = { element: target, kind: 'control' };
          setFocusCard(null);
          return;
        }
        owner.current = { element: target, key, kind: 'card' };
        setFocusCard(key);
        setCurrent(key);
        return;
      }
      const previewed = openCardNow.current;
      if (previewed !== null && target.closest(PANEL) !== null) {
        owner.current = { element: target, key: previewed, kind: 'preview' };
        setFocusCard(previewed);
        return;
      }
      if (
        held !== null &&
        held.kind !== 'control' &&
        target.closest('[role="dialog"], [role="alertdialog"]') !== null
      ) {
        owner.current = { element: target, key: held.key, kind: 'dialog' };
        return;
      }
      owner.current = null;
      setFocusCard(null);
    };
    // Focus that leaves for nothing (a press on the page) lets go; focus lost to a removal does not.
    const onFocusOut = (event: FocusEvent) => {
      const { target } = event;
      if (event.relatedTarget !== null || !(target instanceof Element)) {
        return;
      }
      queueMicrotask(() => {
        if (target.isConnected && owner.current?.element === target) {
          owner.current = null;
          setFocusCard(null);
        }
      });
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [root]);

  const focusIn = (key: string, part: 'button' | 'target') => {
    const card = deckCard(root.current, key);
    const button = part === 'button' ? cardButton(card) : null;
    (button ?? card?.querySelector<HTMLElement>(TARGET))?.focus({ preventScroll: !desktop });
  };

  // Focus whose element went (a card that left, a pager that unmounted, a
  // page that hid) moves to the current card's target, or with no card left
  // to the quiet line. A dialog's focus is resolved after it closes (`restoreFocus`).
  useLayoutEffect(() => {
    const held = owner.current;
    if (held === null || held.kind === 'dialog') {
      return;
    }
    const gone =
      !held.element.isConnected ||
      held.element.closest('[inert], [aria-hidden="true"]') !== null ||
      (held.kind === 'preview' && !keys.includes(held.key));
    if (!gone) {
      return;
    }
    if (current === null) {
      quietLine.current?.focus();
    } else {
      focusIn(current, 'target');
    }
  });

  // The peeking card shows but takes no focus: its controls leave the tab order.
  useLayoutEffect(() => {
    const deck = root.current;
    if (deck === null) {
      return;
    }
    for (const element of deck.querySelectorAll('[data-deck-untabbed]')) {
      if (element.closest('[data-deck-peek]') === null) {
        element.removeAttribute('tabindex');
        element.removeAttribute('data-deck-untabbed');
      }
    }
    for (const element of deck.querySelectorAll('[data-deck-peek] :is(button, a[href])')) {
      if (!element.hasAttribute('tabindex')) {
        element.setAttribute('tabindex', '-1');
        element.setAttribute('data-deck-untabbed', '');
      }
    }
  });

  // The open preview's card must be on the shown page: a focused card on another page outranks it.
  useLayoutEffect(() => {
    if (desktop && openCard !== null && pageOf(keys.indexOf(openCard)) !== page) {
      close();
    }
  }, [close, desktop, keys, openCard, page]);

  const turn = (delta: DeckTurn) => {
    if (sheetOpen) {
      return;
    }
    const target = desktop ? (page + delta) * DECK_PAGE : index + delta;
    const next = target < 0 ? undefined : keys[target];
    if (next === undefined) {
      return;
    }
    const active = document.activeElement;
    // Only this deck's cards: focus in another deck's card stays there.
    const fromCard =
      active !== null &&
      ((root.current?.contains(active) === true && active.closest('[data-deck-card]') !== null) ||
        (desktop && openKey !== null && active.closest(PANEL) !== null));
    flushSync(() => {
      setCurrent(next);
      setInstant(false);
    });
    if (fromCard) {
      focusIn(next, 'target');
    }
    if (desktop) {
      if (openKey !== null) {
        close();
      }
      const { first, last } = deckRange({ count: keys.length, page: pageOf(target) });
      announce(`${String(first)}–${String(last)} of ${String(keys.length)}`);
    } else if (!fromCard) {
      const card = cards[target];
      announce(`${String(target + 1)} of ${String(keys.length)}: ${card?.card.title ?? ''}`);
    }
  };

  const turnTo = (key: string): boolean => {
    if (!keys.includes(key)) {
      return false;
    }
    // A preview whose card is now off the shown page closes in the turn's own commit (the effect above).
    flushSync(() => {
      setCurrent(key);
      setInstant(true);
    });
    focusIn(key, 'button');
    return true;
  };

  useBleedToScreenEdge(root, !desktop && cards.length > 1);

  useImperativeHandle(handle, () => ({
    restoreFocus: (key: string) => {
      onDialogReturn(key);
      // A kept successor is still in the deck; it serves one return.
      const successor = departed?.key === key ? departed.successor : null;
      if (successor !== null) {
        setDeparted(null);
      }
      const fallback = successor ?? current;
      const to = keys.includes(key) ? key : fallback;
      if (to === null || !keys.includes(to)) {
        quietLine.current?.focus();
        return;
      }
      flushSync(() => {
        setCurrent(to);
        setInstant(true);
      });
      focusIn(to, to === key ? 'button' : 'target');
    },
    turnTo,
  }));

  if (cards.length === 0) {
    return <Quiet ref={quietLine}>{quiet}</Quiet>;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const deck = root.current;
    if (
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      deck?.contains(event.target) !== true
    ) {
      return;
    }
    event.preventDefault();
    turn(event.key === 'ArrowRight' ? 1 : -1);
  };

  const cardOf = (card: DeckCard) => (
    <FeedCard previewKey={card.previewKey} {...card.card} action={actionOf(card)} />
  );
  const position = (at: number) => `${String(at + 1)} of ${String(keys.length)}`;

  const shownCards = (): ReactNode => {
    if (desktop) {
      return (
        <CardGrid held={pages > 1}>
          {cards.map((card, at) => {
            const shown = pageOf(at) === page;
            return (
              <div
                key={card.key}
                role="group"
                aria-label={position(at)}
                aria-hidden={shown ? undefined : true}
                inert={!shown}
                data-deck-card={card.key}
                data-current={at === index ? '' : undefined}
                className={cn('grid', pages > 1 && SLOT[at % DECK_PAGE], !shown && 'invisible')}
              >
                {cardOf(card)}
              </div>
            );
          })}
        </CardGrid>
      );
    }
    // One card stays in the track, still and with no peek or pager, so a card that
    // leaves never remounts the one that stays and closes its open preview.
    const single = cards.length === 1;
    return (
      <>
        <SwipeTrack
          index={index}
          count={keys.length}
          itemKey={current ?? ''}
          instant={instant}
          enabled={!sheetOpen}
          onTurn={turn}
          onDragChange={(dragging) => {
            setDuringDrag(dragging ? incoming : null);
          }}
          peek={single ? 0 : PEEK}
          gap={single ? 0 : GAP}
          // The deck runs past the right gutter to the screen's edge (`useBleedToScreenEdge`).
          className={single ? undefined : '-mr-(--deck-bleed)'}
        >
          {cards.map((card, at) => (
            <div
              key={card.key}
              role="group"
              aria-label={position(at)}
              aria-hidden={at === index ? undefined : true}
              inert={at !== index && at !== index + 1}
              data-deck-card={card.key}
              data-deck-peek={at === index + 1 ? '' : undefined}
              data-current={at === index ? '' : undefined}
              className="grid w-(--swipe-slide) shrink-0"
            >
              {cardOf(card)}
            </div>
          ))}
        </SwipeTrack>
        {!single && <PhonePager index={index} count={keys.length} onTurn={turn} />}
      </>
    );
  };

  return (
    // Left and Right turn the deck from anywhere in it; the cards and arrows are the controls.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={root}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className={cn('mt-8 first:mt-0', className)}
    >
      <SectionHead
        id={headingId}
        title={title}
        count={
          items === undefined
            ? keys.length
            : `${counted(keys.length, 'card')}, ${counted(items, 'item')}`
        }
        seeAll={seeAll}
        pager={
          desktop && pages > 1 ? (
            <DesktopPager page={page} pages={pages} count={keys.length} onTurn={turn} />
          ) : undefined
        }
      />
      {shownCards()}
      <p role="status" className="sr-only">
        {announcement.text}
        {/* The same text twice is still a change, so it is read twice. */}
        {announcement.count % 2 === 1 ? '\u00a0' : ''}
      </p>
    </section>
  );
}
