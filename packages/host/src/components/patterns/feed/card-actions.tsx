import { useCallback, useMemo, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { RETURN_TARGET_ATTRIBUTE } from '../../../lib/walkthrough-mark';
import { ActionButton } from '../../ui/action-button';
import type { Preview } from './preview-panel';

/*
 * A feed card's one action, shared by the surfaces that show the needs-you
 * cards (ADR 0019, MMR-723 refinement: The list's state): the Needs you deck
 * and the Needs you page's grouped list. It holds the writes in flight,
 * offline's `aria-disabled`, the card's outline button, the preview's footer
 * action, and a refused write's return to the pressed control. A surface
 * finds its cards by an identity attribute it passes in.
 */

/**
 * A write's progress, reported by the action that runs it. While it is in
 * flight the card's button and its preview's action are `aria-disabled`.
 * `landed` settles it: the card leaves only when the refreshed set drops it.
 * `refused` settles it too, and returns focus to the pressed control while
 * focus is still in that card or its preview.
 */
export type CardWrite = { start: () => void; landed: () => void; refused: () => void };

/** A press on a card's action, from the card or from its preview's footer. */
export type CardPress = {
  from: 'card' | 'preview';
  /** The card's own button: the opener a next surface returns focus to. */
  button: HTMLElement | null;
  write: CardWrite;
};

/**
 * A card's one action. A `write` runs in place (_Clear stop_), so its preview
 * stays open while it is in flight; a `dialog` opens a dialog (_Answer…_);
 * both are `aria-disabled` offline and in flight. `navigate` opens another
 * surface (_Review N decisions_) and stays live offline.
 */
export type CardAction = {
  kind: 'write' | 'dialog' | 'navigate';
  label: string;
  /** The accessible name, when the label alone does not say what it acts on. */
  name?: string;
  /**
   * The name of the return target the button carries (`data-walkthrough-return`,
   * MMR-714), so a walkthrough's return finds it in the document.
   */
  returnTarget?: string;
  run: (press: CardPress) => void;
};

/** What the hook needs of a card: its identity, its preview's key, and its action. */
export type ActionCard = { key: string; previewKey: string; action?: CardAction };

const PANEL = '[data-slot="drawer-content"]';

/** A surface's card element for an identity, found by the surface's identity attribute. */
export function cardElement(
  root: HTMLElement | null,
  identity: string,
  key: string,
): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>(`[${identity}]`) ?? []) {
    if (element.getAttribute(identity) === key) {
      return element;
    }
  }
  return null;
}

/**
 * The actions of a surface's cards. `identity` is the attribute that carries a
 * card's key on its element inside `root` (`data-deck-card` on the deck).
 * `button` draws a card's outline button; `preview` adds the card's action to
 * its preview; `dialogCard` is the card whose dialog is open, from the press
 * that opened it, which in Safari focuses nothing, until `dialogReturned`.
 */
export function useCardActions<Card extends ActionCard>({
  cards,
  preview,
  offline,
  root,
  identity,
}: {
  cards: readonly Card[];
  preview: (previewKey: string) => Omit<Preview, 'action'> | undefined;
  offline: boolean;
  root: RefObject<HTMLElement | null>;
  identity: string;
}) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [dialogCard, setDialogCard] = useState<string | null>(null);

  const settle = useCallback((key: string) => {
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const blocked = useCallback(
    (card: Card) =>
      card.action !== undefined &&
      card.action.kind !== 'navigate' &&
      (offline || pending.has(card.key)),
    [offline, pending],
  );

  const press = useCallback(
    (card: Card, from: CardPress['from'], button: HTMLElement | null) => {
      const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const write: CardWrite = {
        landed: () => {
          settle(card.key);
        },
        refused: () => {
          settle(card.key);
          const active = document.activeElement;
          const panel = pressed?.closest(PANEL) ?? null;
          const stillThere =
            active !== null &&
            (cardElement(root.current, identity, card.key)?.contains(active) === true ||
              panel?.contains(active) === true);
          if (stillThere && pressed?.isConnected === true) {
            pressed.focus();
          }
        },
        start: () => {
          setPending((current) => new Set(current).add(card.key));
        },
      };
      if (card.action?.kind === 'dialog') {
        setDialogCard(card.key);
      }
      card.action?.run({ button, from, write });
    },
    [identity, root, settle],
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

  const button = (card: Card): ReactNode => {
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
        {...(action.returnTarget === undefined
          ? {}
          : { [RETURN_TARGET_ATTRIBUTE]: action.returnTarget })}
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

  const dialogReturned = useCallback((key: string) => {
    setDialogCard((open) => (open === key ? null : open));
  }, []);

  return { button, dialogCard, dialogReturned, preview: previewOf };
}
