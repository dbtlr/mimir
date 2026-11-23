import {
  useCallback,
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
import { ActionButton } from '../../ui/action-button';
import { useDrawerSide } from '../../ui/drawer';
import { SwipeTrack } from '../../ui/swipe-track';
import { FeedCard } from './card';
import { CardGrid } from './card-grid';
import { DECK_PAGE, deckRange, pageCount, pageOf, reconcileCurrent } from './deck-model';
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

/**
 * A write's progress, reported by the action that runs it. While it is in
 * flight the card's button and its preview's action are `aria-disabled`.
 * `landed` settles it: the card leaves only when the refreshed set drops it.
 * `refused` settles it too, and returns focus to the pressed control while
 * focus is still in that card or its preview.
 */
export type DeckWrite = { start: () => void; landed: () => void; refused: () => void };

/** A press on a card's action, from the card or from its preview's footer. */
export type DeckPress = {
  from: 'card' | 'preview';
  /** The card's own button: the opener a next surface returns focus to. */
  button: HTMLElement | null;
  write: DeckWrite;
};

/**
 * A card's one action. A `write` runs in place (_Clear stop_), so its preview
 * stays open while it is in flight; a `dialog` opens a dialog (_Answer…_);
 * both are `aria-disabled` offline and in flight. `navigate` opens another
 * surface (_Review N decisions_) and stays live offline.
 */
export type DeckAction = {
  kind: 'write' | 'dialog' | 'navigate';
  label: string;
  /** The accessible name, when the label alone does not say what it acts on. */
  name?: string;
  run: (press: DeckPress) => void;
};

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
   * else its target; once it has left, its successor's target; with no card
   * left, the quiet line.
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
const OWN_BUTTON = '[data-slot="feed-card-action"] > *';
const PANEL = '[data-slot="drawer-content"]';

/** The deck's card element for an identity. */
function cardElement(root: HTMLElement | null, key: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>('[data-deck-card]') ?? []) {
    if (element.dataset.deckCard === key) {
      return element;
    }
  }
  return null;
}

export function FeedDeck({ cards, preview, offline = false, ref, ...rest }: FeedDeckProps) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLElement | null>(null);
  const quietLine = useRef<HTMLParagraphElement>(null);

  const settle = useCallback((key: string) => {
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const blocked = useCallback(
    (card: DeckCard) =>
      card.action !== undefined &&
      card.action.kind !== 'navigate' &&
      (offline || pending.has(card.key)),
    [offline, pending],
  );

  const press = useCallback(
    (card: DeckCard, from: DeckPress['from'], button: HTMLElement | null) => {
      const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const write: DeckWrite = {
        landed: () => {
          settle(card.key);
        },
        refused: () => {
          settle(card.key);
          const active = document.activeElement;
          const panel = pressed?.closest(PANEL) ?? null;
          const stillThere =
            active !== null &&
            (cardElement(root.current, card.key)?.contains(active) === true ||
              panel?.contains(active) === true);
          if (stillThere && pressed?.isConnected === true) {
            pressed.focus();
          }
        },
        start: () => {
          setPending((current) => new Set(current).add(card.key));
        },
      };
      card.action?.run({ button, from, write });
    },
    [settle],
  );

  const byPreview = useMemo(() => new Map(cards.map((card) => [card.previewKey, card])), [cards]);

  const previewOf = useCallback(
    (previewKey: string): Preview | undefined => {
      const card = byPreview.get(previewKey);
      const base = card === undefined ? undefined : preview(previewKey);
      const action = card?.action;
      if (card === undefined || base === undefined || action === undefined) {
        return base;
      }
      return {
        ...base,
        action: {
          disabled: blocked(card),
          keepsOpen: action.kind === 'write',
          label: action.label,
          name: action.name,
          onAction: (button) => {
            press(card, 'preview', button);
          },
        },
      };
    },
    [blocked, byPreview, preview, press],
  );

  const actionOf = (card: DeckCard): ReactNode => {
    const { action } = card;
    if (action === undefined) {
      return undefined;
    }
    const off = blocked(card);
    return (
      <ActionButton
        size="form"
        variant="formOutline"
        className="md:h-9"
        aria-label={action.name}
        aria-disabled={off ? true : undefined}
        onClick={(event) => {
          if (!off) {
            press(card, 'card', event.currentTarget);
          }
        }}
      >
        {action.label}
      </ActionButton>
    );
  };

  return (
    <FeedPreview
      preview={previewOf}
      fallbackFocus={() =>
        root.current?.querySelector<HTMLElement>(`[data-current] ${TARGET}`) ?? quietLine.current
      }
    >
      <DeckBody
        {...rest}
        cards={cards}
        actionOf={actionOf}
        handle={ref}
        root={root}
        quietLine={quietLine}
      />
    </FeedPreview>
  );
}

/** Who holds focus in or for the deck, so focus can move on when that element goes. */
type FocusOwner =
  | { kind: 'card'; key: string; element: Element }
  | { kind: 'preview'; key: string; element: Element }
  | { kind: 'dialog'; key: string; element: Element }
  | { kind: 'control'; element: Element };

function DeckBody({
  title,
  seeAll,
  cards,
  quiet,
  className,
  actionOf,
  handle,
  root,
  quietLine,
}: Omit<FeedDeckProps, 'preview' | 'offline' | 'ref'> & {
  actionOf: (card: DeckCard) => ReactNode;
  handle: Ref<FeedDeckHandle> | undefined;
  root: RefObject<HTMLElement | null>;
  quietLine: RefObject<HTMLParagraphElement | null>;
}) {
  const headingId = useId();
  const desktop = useDrawerSide() === 'right';
  const { openKey, modal, close } = useFeedPreviewControl();
  const keys = useMemo(() => cards.map((card) => card.key), [cards]);
  const signature = keys.join('\n');
  const openCard = cards.find((card) => card.previewKey === openKey)?.key ?? null;

  const [current, setCurrent] = useState<string | null>(keys[0] ?? null);
  const [focusCard, setFocusCard] = useState<string | null>(null);
  const [instant, setInstant] = useState(false);
  const [seen, setSeen] = useState({ keys, open: openCard, signature });
  const [departed, setDeparted] = useState<Readonly<Record<string, string | null>>>({});
  const [announcement, setAnnouncement] = useState({ count: 0, text: '' });
  const announce = (text: string) => {
    setAnnouncement((last) => ({ count: last.count + 1, text }));
  };

  // A refetch: apply it by identity (deck-model.ts).
  if (seen.signature !== signature) {
    const anchor = focusCard ?? (desktop ? seen.open : null);
    const next = reconcileCurrent({ after: keys, anchor, before: seen.keys, current, desktop });
    const left = seen.keys.filter((key) => !keys.includes(key));
    setDeparted((before) => ({
      ...before,
      ...Object.fromEntries(left.map((key) => [key, next])),
    }));
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
    const card = cardElement(root.current, key);
    const button = part === 'button' ? card?.querySelector<HTMLElement>(OWN_BUTTON) : null;
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
    const fromCard =
      active !== null &&
      (active.closest('[data-deck-card]') !== null ||
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
    flushSync(() => {
      setCurrent(key);
      setInstant(true);
    });
    if (
      desktop &&
      openCard !== null &&
      pageOf(keys.indexOf(openCard)) !== pageOf(keys.indexOf(key))
    ) {
      close();
    }
    focusIn(key, 'button');
    return true;
  };

  useImperativeHandle(handle, () => ({
    restoreFocus: (key: string) => {
      const successor = departed[key];
      const to = keys.includes(key) ? key : (successor ?? current);
      if (to === null || to === undefined || !keys.includes(to)) {
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
    if (cards.length === 1) {
      return cards.map((card) => (
        <div
          key={card.key}
          role="group"
          aria-label={position(0)}
          data-deck-card={card.key}
          data-current=""
          className="grid"
        >
          {cardOf(card)}
        </div>
      ));
    }
    return (
      <>
        <SwipeTrack
          index={index}
          count={keys.length}
          itemKey={current ?? ''}
          instant={instant}
          enabled={!sheetOpen}
          onTurn={turn}
          peek={PEEK}
          gap={GAP}
          // The deck runs past the right gutter to the screen's edge.
          className="-mr-3.5"
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
        <PhonePager index={index} count={keys.length} onTurn={turn} />
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
        count={keys.length}
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
