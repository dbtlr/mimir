import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { cn } from '../../../lib/cn';
import { ActionButton, actionButtonVariants } from '../../ui/action-button';
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle, useDrawerSide } from '../../ui/drawer';
import { CloseIcon } from '../../ui/icons';
import { restingRoom, restsOf } from '../form-sheet';
import type { BlockExtent } from '../form-sheet';
import type { FinalFocus } from '../opener';
import type { FeedLink } from './link';
import { FeedStatusLine } from './status-line';
import { tabNeighbour, tabSequence } from './tab-order';

/** One fact in a preview's definition list. */
export type PreviewFact = { label: string; value: ReactNode };

/**
 * The card's one action, which the preview offers as its one solid button.
 * The panel closes as it runs, and `onAction` gets the selected card's own
 * button: when the action leaves the panel for another surface (a bundle's
 * walkthrough), that button is the surface's opener.
 */
export type PreviewAction = {
  label: string;
  /** The accessible name, when the label alone does not say what it acts on ("Answer HUGI-15"). */
  name?: string;
  onAction: (cardButton: HTMLElement | null) => void;
};

/**
 * What a preview shows (ADR 0019, MMR-720 refinement), from the feature: the
 * card's status line and title, the reason the item is here in complete
 * sentences, optional text after it (a seed's, cut at a sentence's end), the
 * facts that matter, the card's action, and where Open leads.
 */
export type Preview = {
  lead: ReactNode;
  id?: string;
  age?: string;
  title: string;
  reason: ReactNode;
  text?: ReactNode;
  facts?: readonly PreviewFact[];
  open: FeedLink;
  action?: PreviewAction;
};

/** A relation in a fact (a parent, a dependency, a bundle's task): plain text, its ID then its title. */
export function PreviewRelation({ id, title }: { id: string; title: string }) {
  return (
    <span className="block not-first:mt-1">
      <span className="mr-1.5 font-mono text-ink-dim [font-size-adjust:var(--mono-adjust)]">
        {id}
      </span>{' '}
      {title}
    </span>
  );
}

export type PreviewPanelProps = {
  open: boolean;
  onClose: () => void;
  preview: Preview | undefined;
  /** Which record the panel shows; a change while it is open is a switch. */
  shownKey: string | undefined;
  /** Where focus goes on close: the card that opened the latest preview. */
  finalFocus?: FinalFocus;
  /** Where Shift+Tab from the title goes on desktop, where nothing traps focus. */
  tabBack?: () => HTMLElement | null;
  /** Where Tab from the panel's last control goes on desktop. */
  tabOn?: (panel: HTMLElement) => HTMLElement | null;
  /** Runs once the panel has finished closing, after its slide. */
  onClosed?: () => void;
};

/** A button in the footer: on a phone it shares the row in equal tracks and wraps its label. */
const FOOTER_BUTTON =
  'max-md:h-auto max-md:min-h-11 max-md:min-w-0 max-md:px-3 max-md:py-2.5 max-md:text-center max-md:whitespace-normal';

/**
 * The preview panel (ADR 0019, MMR-720 refinement): a feed card's key facts,
 * its one action, and Open. Below `md` a modal bottom sheet over the scrim
 * that fits its content up to 88% of the visible viewport; from `md` up a 440
 * panel under the top bar, non-modal and without a scrim, so the feed beside
 * it stays live. Opening and switching move focus to the title; on desktop
 * nothing traps it, so `tabBack` and `tabOn` carry Tab out to the feed. The
 * header and footer stay put and only the body scrolls. It reads no data; a
 * `FeedPreview` usually drives it.
 */
export function PreviewPanel({
  open,
  onClose,
  preview,
  shownKey,
  finalFocus,
  tabBack,
  tabOn,
  onClosed,
}: PreviewPanelProps) {
  const desktop = useDrawerSide() === 'right';
  const title = useRef<HTMLHeadingElement>(null);

  useTabFromOutside({ active: open && desktop && preview !== undefined, tabBack, tabOn, title });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!desktop || event.key !== 'Tab') {
      return;
    }
    // The panel sits after the selected card in the tab order, the title
    // first though it is out of the sequence (`tabindex="-1"`): Shift+Tab from
    // Close, the first control, reaches the title, and from the title the card.
    const controls = tabSequence(event.currentTarget);
    let next: HTMLElement | null | undefined;
    if (event.shiftKey && event.target === title.current) {
      next = tabBack?.();
    } else if (event.shiftKey && event.target === controls[0]) {
      next = title.current;
    } else if (!event.shiftKey && event.target === controls.at(-1)) {
      next = tabOn?.(event.currentTarget);
    }
    if (next !== null && next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <Drawer
      open={open && preview !== undefined}
      modal={!desktop}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          onClosed?.();
        }
      }}
    >
      {/* The desktop panel draws no scrim: a press on another card must reach it. */}
      {!desktop && <DrawerBackdrop />}
      <DrawerContent
        size="preview"
        initialFocus={() => title.current}
        finalFocus={finalFocus}
        onKeyDown={onKeyDown}
        className="gap-0 overflow-hidden p-0 data-[side=bottom]:pb-0"
      >
        {preview !== undefined && (
          // A switch remounts the content: it changes in place at once, the
          // body starts at its top, and focus moves to the new title.
          <PreviewContent
            key={shownKey}
            open={open}
            preview={preview}
            title={title}
            settles={!desktop}
            onClose={onClose}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** Where a Tab from outside the panel goes, or `leave` when only the panel is left before the page's end. */
type TabFromOutside = HTMLElement | 'leave' | null;

/**
 * The desktop panel's place in the tab order from outside it: it sits after
 * the selected card's stretched target (`card`) and before the control after
 * it (`cardNext`). Tab from anywhere else passes the panel by, so focus never
 * loops back into it and Tab past the page's end leaves the document. `null`
 * leaves the key to the browser.
 */
function tabFromOutside({
  from,
  backward,
  panel,
  title,
  card,
  cardNext,
}: {
  from: HTMLElement;
  backward: boolean;
  panel: HTMLElement;
  title: HTMLElement | null;
  card: HTMLElement | null;
  cardNext: HTMLElement | null;
}): TabFromOutside {
  if (!backward && from === card) {
    return title;
  }
  if (backward && from === cardNext) {
    return tabSequence(panel).at(-1) ?? title;
  }
  const native = tabNeighbour({ backward, from, skip: null });
  if (native === null || !panel.contains(native)) {
    return null;
  }
  return tabNeighbour({ backward, from, skip: panel }) ?? 'leave';
}

/** Carries Tab from outside the open desktop panel by `tabFromOutside`'s order. */
function useTabFromOutside({
  active,
  tabBack,
  tabOn,
  title,
}: {
  active: boolean;
  tabBack: (() => HTMLElement | null) | undefined;
  tabOn: ((panel: HTMLElement) => HTMLElement | null) | undefined;
  title: RefObject<HTMLHeadingElement | null>;
}) {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const owner = title.current?.ownerDocument ?? document;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey) {
        return;
      }
      const panel = title.current?.closest<HTMLElement>('[data-slot="drawer-content"]') ?? null;
      const from = event.target;
      if (panel === null || !(from instanceof HTMLElement) || panel.contains(from)) {
        return;
      }
      const next = tabFromOutside({
        backward: event.shiftKey,
        card: tabBack?.() ?? null,
        cardNext: tabOn?.(panel) ?? null,
        from,
        panel,
        title: title.current,
      });
      if (next === 'leave') {
        // Nothing but the panel lies ahead: it sits out this one key, so focus leaves the page.
        panel.inert = true;
        setTimeout(() => {
          panel.inert = false;
        }, 0);
      } else if (next !== null) {
        event.preventDefault();
        next.focus();
      }
    };
    owner.addEventListener('keydown', onKey);
    return () => {
      owner.removeEventListener('keydown', onKey);
    };
  }, [active, tabBack, tabOn, title]);
}

/** The header, body, and footer of one record's preview. */
function PreviewContent({
  open,
  preview,
  title,
  settles,
  onClose,
}: {
  open: boolean;
  preview: Preview;
  title: RefObject<HTMLHeadingElement | null>;
  /** Whether a scroll settles on a rest: the phone's capped sheet. */
  settles: boolean;
  onClose: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [continues, setContinues] = useState(false);
  const { action } = preview;

  useEffect(() => {
    if (open) {
      title.current?.focus({ preventScroll: true });
    }
  }, [open, title]);

  return (
    <>
      <header
        data-scrolled={scrolled ? '' : undefined}
        className="relative z-10 shrink-0 border-b border-line bg-well-850 pt-3 pr-14 pb-4 pl-5 transition-shadow data-scrolled:elevation-edge md:pt-7 md:pr-16 md:pb-5 md:pl-8"
      >
        <FeedStatusLine
          lead={preview.lead}
          recordId={preview.id}
          age={preview.age}
          className="mb-2 leading-5"
        />
        <DrawerTitle
          ref={title}
          tabIndex={-1}
          className="m-0 rounded text-dossier leading-6 font-semibold text-pretty text-ink-bright wrap-anywhere outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-accent"
        >
          {preview.title}
        </DrawerTitle>
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="absolute top-0 right-2 inline-flex size-11 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:top-5 md:right-[22px] md:size-9"
        >
          <CloseIcon className="size-5 md:size-[18px]" />
        </button>
      </header>
      <PreviewBody settles={settles} onScrolled={setScrolled} onContinues={setContinues}>
        <div className="text-base leading-[25px] text-pretty text-ink-bright [&_b]:font-semibold [&_strong]:font-semibold">
          {preview.reason}
        </div>
        {preview.text !== undefined && (
          <div
            data-slot="preview-text"
            className="mt-3 text-body leading-[23px] text-pretty text-ink"
          >
            {preview.text}
          </div>
        )}
        {preview.facts !== undefined && preview.facts.length > 0 && (
          <dl className="mt-5 mb-0 grid grid-cols-[104px_minmax(0,1fr)] gap-x-4 gap-y-3.5 border-t border-line pt-5">
            {preview.facts.map((fact) => (
              <div
                key={fact.label}
                data-slot="preview-fact"
                className="col-span-2 grid grid-cols-subgrid"
              >
                <dt className="pt-px text-meta leading-5 text-ink-dim">{fact.label}</dt>
                <dd className="m-0 text-body leading-[22px] text-ink-bright wrap-anywhere">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </PreviewBody>
      <div
        data-slot="preview-footer"
        data-continues={continues ? '' : undefined}
        className={cn(
          'relative z-10 grid shrink-0 gap-3 border-t border-line bg-well-850 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] transition-shadow data-continues:elevation-edge-up md:flex md:justify-end md:px-8 md:py-4',
          action === undefined ? 'grid-cols-1' : 'grid-cols-2',
        )}
      >
        <Link
          {...preview.open}
          aria-label={preview.id === undefined ? undefined : `Open ${preview.id}`}
          className={cn(
            actionButtonVariants({ size: 'form', variant: 'formOutline' }),
            FOOTER_BUTTON,
          )}
        >
          Open
        </Link>
        {action !== undefined && (
          <ActionButton
            size="form"
            variant="action"
            aria-label={action.name}
            onClick={() => {
              action.onAction(null);
            }}
            className={FOOTER_BUTTON}
          >
            {action.label}
          </ActionButton>
        )}
      </div>
    </>
  );
}

/** The extent of an element in its scroll parent's scroll space. */
function extentOf(element: Element, origin: number): BlockExtent {
  const rect = element.getBoundingClientRect();
  return { bottom: rect.bottom - origin, top: rect.top - origin };
}

/**
 * Where the body rests (DESIGN.md, Preview panel: a capped sheet rests on a
 * whole fact): the top, the reason, the text, and each fact. The fact list's
 * hairline makes no rest of its own, so the first fact's rest hides it whole
 * and puts that fact 20 below the header.
 */
function measureRests(element: HTMLElement): number[] {
  const origin = element.getBoundingClientRect().top - element.scrollTop;
  const content = element.firstElementChild;
  if (content === null) {
    return [];
  }
  const blocks: BlockExtent[] = [];
  let hairline: number | undefined;
  for (const child of content.children) {
    if (child.tagName === 'DL') {
      const top = child.getBoundingClientRect().top - origin;
      hairline = blocks.length;
      blocks.push({ bottom: top + 1, top: top + 1 });
      for (const fact of child.children) {
        blocks.push(extentOf(fact, origin));
      }
    } else {
      blocks.push(extentOf(child, origin));
    }
  }
  const topPadding = Number.parseFloat(getComputedStyle(element).paddingTop);
  const rests = restsOf(blocks, false, Number.isNaN(topPadding) ? 0 : topPadding);
  return hairline === undefined ? rests : rests.filter((_, index) => index !== hairline);
}

/**
 * Where a scroll that stopped at `scrollTop` settles, having moved from the
 * rest at `from`: on a rest already, it stays; otherwise it goes on to the
 * next rest the way it moved, so a short swipe still gets somewhere. The rests
 * are the body's own, its top, and its end.
 */
function settleRest(element: HTMLElement, from: number): number {
  const end = element.scrollHeight - element.clientHeight;
  const at = element.scrollTop;
  const rests = [0, end, ...measureRests(element)]
    .filter((rest) => rest >= 0 && rest <= end)
    .toSorted((x, y) => x - y);
  if (rests.some((rest) => Math.abs(rest - at) < 1)) {
    return at;
  }
  return at > from
    ? (rests.find((rest) => rest > at) ?? end)
    : (rests.findLast((rest) => rest < at) ?? 0);
}

/**
 * The body, the one part that scrolls. It adds the bottom room the end of its
 * scroll needs to rest cleanly, and reports whether it has scrolled (the
 * header's shadow) and whether it runs on under the footer (the footer's cue).
 * When it `settles` (the phone's capped sheet), a swipe or scroll that comes to
 * a stop between rests glides on to the next one, so it rests on a whole fact.
 */
function PreviewBody({
  settles,
  onScrolled,
  onContinues,
  children,
}: {
  settles: boolean;
  onScrolled: (scrolled: boolean) => void;
  onContinues: (continues: boolean) => void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const roomRef = useRef(0);

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) {
      return undefined;
    }
    const report = () => {
      onScrolled(element.scrollTop > 0);
      onContinues(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    const measure = () => {
      if (element.clientHeight > 0) {
        const naturalEnd = element.scrollHeight - roomRef.current - element.clientHeight;
        const next = restingRoom(naturalEnd, measureRests(element));
        if (next !== roomRef.current) {
          roomRef.current = next;
          setRoom(next);
        }
      }
      report();
    };
    // Where the body last came to rest, so a settle knows which way it moved.
    let rested = element.scrollTop;
    const settle = () => {
      const rest = settleRest(element, rested);
      rested = rest;
      if (Math.abs(rest - element.scrollTop) >= 1) {
        const reduced = element.ownerDocument.defaultView?.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        element.scrollTo({ behavior: reduced === true ? 'instant' : 'smooth', top: rest });
      }
    };
    measure();
    element.addEventListener('scroll', report, { passive: true });
    if (settles) {
      element.addEventListener('scrollend', settle);
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const content = element.firstElementChild;
    if (content !== null) {
      observer?.observe(content);
    }
    return () => {
      element.removeEventListener('scroll', report);
      element.removeEventListener('scrollend', settle);
      observer?.disconnect();
    };
  }, [settles, onScrolled, onContinues]);

  return (
    <div
      ref={body}
      data-slot="preview-body"
      style={room > 0 ? { paddingBottom: `calc(var(--preview-body-end) + ${String(room)}px)` } : {}}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 pb-(--preview-body-end) [--preview-body-end:2rem] md:px-8 md:pt-8 md:[--preview-body-end:2.5rem]"
    >
      <div>{children}</div>
    </div>
  );
}
