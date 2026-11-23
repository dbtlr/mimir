import { useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { useDrawerSide } from '../../ui/drawer';
import { PreviewPanel } from './preview-panel';
import type { Preview } from './preview-panel';
import { usePreviewClaim } from './preview-room';
import { tabNeighbour } from './tab-order';

type FeedPreviewState = {
  selected: string | null;
  toggle: (key: string, opener: HTMLElement) => void;
};

const FeedPreviewContext = createContext<FeedPreviewState | null>(null);

/** A card's part in its feed's preview: whether it is the selected card, and its tap. */
export function useCardPreview(key: string): {
  selected: boolean;
  toggle: (opener: HTMLElement) => void;
} {
  const state = useContext(FeedPreviewContext);
  if (state === null) {
    throw new Error('A FeedCard opens its preview, so it sits inside a FeedPreview.');
  }
  const { selected, toggle } = state;
  return {
    selected: selected === key,
    toggle: (opener) => {
      toggle(key, opener);
    },
  };
}

/** The roles of a control; a press on any other role (a chart's `img`) is on empty space. */
const CONTROL_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'tree',
  'treeitem',
];

/** What a press in the feed lands on when it is not empty space: a control, or the panel's own layer. */
const CONTROL = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[tabindex]',
  '[contenteditable]',
  '[data-slot="drawer-viewport"]',
  ...CONTROL_ROLES.map((role) => `[role="${role}"]`),
].join(', ');

/** A card's own button, stacked over its stretched target. */
const CARD_BUTTON = '[data-slot="feed-card-action"] > *';

/** The card a stretched target belongs to. */
function cardOf(opener: HTMLElement | null): HTMLElement | null {
  return opener?.closest<HTMLElement>('[data-slot="feed-card"]') ?? null;
}

/** Whether an element is still on the page and can take focus. */
function usable(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && element.closest('[inert]') === null;
}

/**
 * A feed whose cards open a preview (ADR 0019, MMR-720 refinement). It holds
 * which card is selected and applies the panel's rules: a tap on another card
 * switches the preview and makes that card the opener; a tap on the selected
 * card, a press in empty feed space, Escape from the feed or the panel, Close,
 * a navigation, or a card in another feed on the page (the page has one
 * preview) closes it; and closing returns focus to the latest opener.
 * After a reflow on open, switch, or close, the selected card scrolls into
 * view at once. `preview` maps a card's `previewKey` to what its preview shows.
 */
export function FeedPreview({
  preview,
  children,
}: {
  preview: (key: string) => Preview | undefined;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // The record the panel shows, kept through its closing slide.
  const [shown, setShown] = useState<string | null>(null);
  // The card followed through reflows, until the panel has closed.
  const [followed, setFollowed] = useState<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const href = useRouterState({ select: (state) => state.location.href });
  const [seenHref, setSeenHref] = useState(href);
  if (seenHref !== href) {
    setSeenHref(href);
    setSelected(null);
  }
  const given = shown === null ? undefined : preview(shown);
  // A selected record that has left the feed has no preview: nothing stays selected.
  if (selected !== null && given === undefined) {
    setSelected(null);
  }
  const open = selected !== null && given !== undefined;
  // The phone's sheet is modal over a scrim; only the desktop panel needs room beside the feed.
  const desktop = useDrawerSide() === 'right';
  const feedId = useId();
  const owner = usePreviewClaim({ open, owner: feedId, panel: desktop });
  // A card in another feed on the page took the preview: this feed's panel closes.
  const [seenOwner, setSeenOwner] = useState(owner);
  if (seenOwner !== owner) {
    setSeenOwner(owner);
    if (owner !== null && owner !== feedId) {
      setSelected(null);
    }
  }

  const close = useCallback(() => {
    setSelected(null);
    const active = document.activeElement;
    // A press on empty space leaves focus nowhere; it goes back to the card.
    if ((active === null || active === document.body) && usable(opener.current)) {
      opener.current.focus({ preventScroll: true });
    }
  }, []);

  // The card's action closes the panel first, then runs with the card's own button.
  const content = useMemo(() => {
    const action = given?.action;
    if (given === undefined || action === undefined) {
      return given;
    }
    return {
      ...given,
      action: {
        ...action,
        onAction: () => {
          const own = cardOf(opener.current)?.querySelector<HTMLElement>(CARD_BUTTON) ?? null;
          setSelected(null);
          action.onAction(own);
        },
      },
    };
  }, [given]);

  const toggle = useCallback((key: string, card: HTMLElement) => {
    opener.current = card;
    setSelected((current) => (current === key ? null : key));
    setShown((current) => (current === key ? current : key));
    setFollowed(cardOf(card));
  }, []);

  const state = useMemo(() => ({ selected, toggle }), [selected, toggle]);

  // A reflow (two columns becoming one beside the panel) can move the card.
  useEffect(() => {
    const element = feed.current;
    if (followed === null || element === null) {
      return undefined;
    }
    const reveal = () => {
      followed.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next !== width) {
        width = next;
        reveal();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [followed]);

  const onFeedClick = (event: MouseEvent<HTMLDivElement>) => {
    if (selected === null || !(event.target instanceof Element)) {
      return;
    }
    const control = event.target.closest(CONTROL);
    if (control === null || !event.currentTarget.contains(control)) {
      close();
    }
  };

  return (
    <FeedPreviewContext.Provider value={state}>
      {/* Clicks and Escape here are the feed's own: the card buttons inside are the controls. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        ref={feed}
        data-slot="feed-preview"
        onClick={onFeedClick}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && selected !== null && !event.defaultPrevented) {
            event.preventDefault();
            close();
          }
        }}
      >
        {children}
      </div>
      <PreviewPanel
        open={open}
        onClose={close}
        preview={content}
        shownKey={shown ?? undefined}
        finalFocus={() => (usable(opener.current) ? opener.current : null)}
        tabBack={() => (usable(opener.current) ? opener.current : null)}
        tabOn={(panel) =>
          usable(opener.current) ? tabNeighbour({ from: opener.current, skip: panel }) : null
        }
        onClosed={() => {
          setFollowed(null);
        }}
      />
    </FeedPreviewContext.Provider>
  );
}
