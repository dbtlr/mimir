import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';

import { FeedCard } from './card';
import { cardElement, useCardActions } from './card-actions';
import type { CardAction } from './card-actions';
import { cardButton } from './card-button';
import { CardGrid } from './card-grid';
import { listSuccessor } from './card-list-model';
import type { KeptSuccessor } from './deck-model';
import type { DeckCardContent } from './deck';
import { FeedPreview, useFeedPreviewControl } from './feed-preview';
import type { Preview } from './preview-panel';
import { Quiet } from './quiet';
import { FeedSection } from './section-head';

/*
 * The grouped card list (ADR 0019, MMR-723 refinement; DESIGN.md, Needs you
 * page): every card of a set, one feed section per group, the cards stacked
 * on a phone and in the Card grid from `md`, and one shared preview. Nothing
 * pages or folds. Focus moves only when the element holding it goes: from a
 * card that left to its successor's target across sections, and with no card
 * left to the quiet line.
 */

/** One card in the list: its identity (never its index), its content, and its preview's key. */
export type ListCard = {
  key: string;
  previewKey: string;
  card: DeckCardContent;
  action?: CardAction;
};

/** A group of cards under its Section head, with the count the caller words. */
export type ListSection = {
  key: string;
  title: string;
  count?: number | string;
  cards: readonly ListCard[];
};

/** What a feature asks of the list from outside it. */
export type FeedCardListHandle = {
  /**
   * Resolves focus after a dialog opened from the card closes: its button,
   * else its target; once it has left, its successor's target, else the
   * first card's; with no card left, the quiet line.
   */
  restoreFocus: (key: string) => void;
  /** Gives the quiet line focus, for a control outside the list that left with the last card. */
  focusQuiet: () => void;
};

/** The attribute that carries a list card's identity. */
const IDENTITY = 'data-list-card';
const TARGET = '[data-slot="feed-card-target"]';
const PANEL = '[data-slot="drawer-content"]';

export function FeedCardList({
  sections,
  preview,
  quiet,
  offline = false,
  ref,
}: {
  sections: readonly ListSection[];
  /** A card's preview, by its `previewKey`; the list adds the card's action. */
  preview: (previewKey: string) => Omit<Preview, 'action'> | undefined;
  /** The quiet line that takes the sections' place when no card remains. */
  quiet: string;
  /** Offline, a card's writes are `aria-disabled` (ADR 0013 §5). */
  offline?: boolean;
  ref?: Ref<FeedCardListHandle>;
}) {
  const cards = useMemo(() => sections.flatMap((section) => section.cards), [sections]);
  const root = useRef<HTMLDivElement>(null);
  const quietLine = useRef<HTMLParagraphElement>(null);
  const actions = useCardActions({ cards, identity: IDENTITY, offline, preview, root });

  return (
    <FeedPreview
      preview={actions.preview}
      // The panel's return once its card has left: where the list already moved focus, else the first card.
      fallbackFocus={() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.current?.contains(active) === true) {
          return active;
        }
        return root.current?.querySelector<HTMLElement>(TARGET) ?? quietLine.current;
      }}
    >
      <ListBody
        sections={sections}
        cards={cards}
        quiet={quiet}
        buttonOf={actions.button}
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

/** Who holds focus for the list, so focus can move on when that element goes. */
type FocusOwner =
  | { kind: 'card'; key: string; element: Element }
  | { kind: 'preview'; key: string; element: Element }
  | { kind: 'dialog'; key: string; element: Element };

function ListBody({
  sections,
  cards,
  quiet,
  buttonOf,
  dialogCard,
  onDialogReturn,
  handle,
  root,
  quietLine,
}: {
  sections: readonly ListSection[];
  cards: readonly ListCard[];
  quiet: string;
  buttonOf: (card: ListCard) => ReactNode;
  dialogCard: string | null;
  onDialogReturn: (key: string) => void;
  handle: Ref<FeedCardListHandle> | undefined;
  root: RefObject<HTMLDivElement | null>;
  quietLine: RefObject<HTMLParagraphElement | null>;
}) {
  const { openKey } = useFeedPreviewControl();
  const keys = useMemo(() => cards.map((card) => card.key), [cards]);
  const signature = keys.join('\n');
  const openCard = cards.find((card) => card.previewKey === openKey)?.key ?? null;
  const [focusCard, setFocusCard] = useState<string | null>(null);
  const [seen, setSeen] = useState({ keys, signature });
  // The successor focus goes to once the card holding it has left.
  const [departed, setDeparted] = useState<KeptSuccessor | null>(null);

  // A refetch: find the holder's successor in the old order, by identity.
  if (seen.signature !== signature) {
    const holder = focusCard ?? dialogCard;
    setDeparted((kept) => listSuccessor({ after: keys, before: seen.keys, holder, kept }));
    setSeen({ keys, signature });
  }

  const owner = useRef<FocusOwner | null>(null);
  const openCardNow = useRef(openCard);
  useEffect(() => {
    openCardNow.current = openCard;
  });

  // Who holds focus: a card, the open preview, or a dialog opened from a card.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const { target } = event;
      if (!(target instanceof Element)) {
        return;
      }
      const held = owner.current;
      const key = target.closest(`[${IDENTITY}]`)?.getAttribute(IDENTITY) ?? null;
      if (key !== null && root.current?.contains(target) === true) {
        owner.current = { element: target, key, kind: 'card' };
        setFocusCard(key);
        return;
      }
      const previewed = openCardNow.current;
      if (previewed !== null && target.closest(PANEL) !== null) {
        owner.current = { element: target, key: previewed, kind: 'preview' };
        setFocusCard(previewed);
        return;
      }
      if (held !== null && target.closest('[role="dialog"], [role="alertdialog"]') !== null) {
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
    const card = cardElement(root.current, IDENTITY, key);
    const button = part === 'button' ? cardButton(card) : null;
    (button ?? card?.querySelector<HTMLElement>(TARGET))?.focus();
  };

  /** A card that left hands its focus to its successor, else the first card, else the quiet line. */
  const focusInPlaceOf = (key: string) => {
    const successor = departed?.key === key ? departed.successor : undefined;
    const to = successor !== undefined && keys.includes(successor) ? successor : keys[0];
    if (to === undefined) {
      quietLine.current?.focus();
    } else {
      focusIn(to, 'target');
    }
  };

  // Focus whose element went moves on. A dialog's focus is resolved after it closes (`restoreFocus`).
  useLayoutEffect(() => {
    const held = owner.current;
    if (held === null || held.kind === 'dialog') {
      return;
    }
    const stays = keys.includes(held.key);
    const gone = !held.element.isConnected || (held.kind === 'preview' && !stays);
    if (!gone) {
      return;
    }
    if (stays && held.kind === 'card') {
      // The card stays but the control in it went (its button): its target takes focus.
      focusIn(held.key, 'target');
    } else {
      focusInPlaceOf(held.key);
    }
  });

  useImperativeHandle(handle, () => ({
    focusQuiet: () => {
      quietLine.current?.focus();
    },
    restoreFocus: (key: string) => {
      onDialogReturn(key);
      if (keys.includes(key)) {
        focusIn(key, 'button');
        return;
      }
      focusInPlaceOf(key);
      setDeparted((kept) => (kept?.key === key ? null : kept));
    },
  }));

  return (
    <div ref={root}>
      {cards.length === 0 ? (
        <Quiet ref={quietLine}>{quiet}</Quiet>
      ) : (
        sections.map((section) => (
          <FeedSection key={section.key} title={section.title} count={section.count}>
            <CardGrid>
              {section.cards.map((card) => (
                <div key={card.key} data-list-card={card.key} className="grid">
                  <FeedCard previewKey={card.previewKey} {...card.card} action={buttonOf(card)} />
                </div>
              ))}
            </CardGrid>
          </FeedSection>
        ))
      )}
    </div>
  );
}
