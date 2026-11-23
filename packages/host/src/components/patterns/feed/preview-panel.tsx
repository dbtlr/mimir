import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { cn } from '../../../lib/cn';
import { ActionButton, actionButtonVariants } from '../../ui/action-button';
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle, useDrawerSide } from '../../ui/drawer';
import { CloseIcon } from '../../ui/icons';
import type { FinalFocus } from '../opener';
import { restsOf, useRestingBody } from '../resting-body';
import type { BlockExtent, MeasuredRests } from '../resting-body';
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
  /** The ID Open leads to when the header names no record (a delivery's bundle), for Open's name. */
  openId?: string;
  action?: PreviewAction;
};

/** Open's accessible name: "Open" and the ID it leads to, the record's own or the bundle's destination. */
function openName({ id, openId }: Preview): string | undefined {
  const target = id ?? openId;
  return target === undefined ? undefined : `Open ${target}`;
}

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
    if (!desktop || event.key !== 'Tab' || !(event.target instanceof HTMLElement)) {
      return;
    }
    const next = tabInPanel({
      backward: event.shiftKey,
      from: event.target,
      panel: event.currentTarget,
      tabBack,
      tabOn,
      title: title.current,
    });
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
            onClose={onClose}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The panel's controls in the order Tab visits them: Close first, as it
 * follows the title, then the rest in the browser's order for the panel.
 */
function panelSequence(
  panel: HTMLElement,
  { backward, from }: { backward: boolean; from: HTMLElement | null },
): HTMLElement[] {
  const controls = tabSequence(panel, { backward, from });
  const close = controls.find((control) => control.dataset.slot === 'preview-close');
  return close === undefined
    ? controls
    : [close, ...controls.filter((control) => control !== close)];
}

/**
 * Where Tab from `from` inside the desktop panel goes. The panel steps through
 * its own sequence itself, so a positive `tabindex` in it, which the browser
 * would visit before the whole page, keeps its place in the panel. The title,
 * out of the sequence (`tabindex="-1"`), comes first: Shift+Tab from it goes to
 * the selected card (`tabBack`), and Tab from the last control to the control
 * after the card's stretched target (`tabOn`). `null` leaves the key to the browser.
 */
function tabInPanel({
  from,
  backward,
  panel,
  title,
  tabBack,
  tabOn,
}: {
  from: HTMLElement;
  backward: boolean;
  panel: HTMLElement;
  title: HTMLElement | null;
  tabBack: (() => HTMLElement | null) | undefined;
  tabOn: ((panel: HTMLElement) => HTMLElement | null) | undefined;
}): HTMLElement | null | undefined {
  const controls = panelSequence(panel, { backward, from });
  if (from === title) {
    return backward ? tabBack?.() : controls[0];
  }
  const index = controls.indexOf(from);
  if (index === -1) {
    return null;
  }
  if (backward) {
    return controls[index - 1] ?? title;
  }
  return controls[index + 1] ?? tabOn?.(panel);
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
    return panelSequence(panel, { backward: true, from: null }).at(-1) ?? title;
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
  onClose,
}: {
  open: boolean;
  preview: Preview;
  title: RefObject<HTMLHeadingElement | null>;
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
          data-slot="preview-close"
          onClick={onClose}
          className="absolute top-0 right-2 inline-flex size-11 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:top-5 md:right-[22px] md:size-9"
        >
          <CloseIcon className="size-5 md:size-[18px]" />
        </button>
      </header>
      <PreviewBody onScrolled={setScrolled} onContinues={setContinues}>
        <div data-slot="preview-prose">
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
        </div>
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
          'relative z-10 grid shrink-0 gap-3 border-t border-line bg-well-850 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] transition-[box-shadow,border-color] data-continues:border-ink-ghost data-continues:elevation-edge-up light:data-continues:border-line-bright md:flex md:justify-end md:px-8 md:py-4',
          action === undefined ? 'grid-cols-1' : 'grid-cols-2',
        )}
      >
        <Link
          {...preview.open}
          aria-label={openName(preview)}
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
              onClose();
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

/** The fact list's top hairline, which a rest hides with the prose above it. */
const HAIRLINE = 1;

/**
 * The body's blocks and their rests (`restsOf`): the reason and the text after
 * it as one block, since the text carries on from the reason, then each fact.
 * The prose block runs on to the fact list's hairline, so the first fact's rest
 * hides that hairline whole, as a form's rest hides a group heading.
 */
function measureRests(element: HTMLElement): MeasuredRests {
  const origin = element.getBoundingClientRect().top - element.scrollTop;
  const prose = element.querySelector('[data-slot="preview-prose"]');
  const facts = [...element.querySelectorAll('[data-slot="preview-fact"]')];
  const list = element.querySelector('dl');
  const extentOf = (block: Element): BlockExtent => {
    const rect = block.getBoundingClientRect();
    return { bottom: rect.bottom - origin, top: rect.top - origin };
  };
  const blocks = prose === null ? facts : [prose, ...facts];
  const extents = blocks.map(extentOf);
  const [first] = extents;
  if (prose !== null && list !== null && first !== undefined) {
    first.bottom = list.getBoundingClientRect().top - origin + HAIRLINE;
  }
  const topPadding = Number.parseFloat(getComputedStyle(element).paddingTop);
  const rests = restsOf(extents, false, Number.isNaN(topPadding) ? 0 : topPadding);
  return { blocks, extents, origin, rests };
}

/**
 * The body, the one part that scrolls. It rests by the Sheets rule
 * (`useRestingBody`): a scroll left mid-way stays, the end of its scroll rests
 * on a whole fact, and a control the keyboard focuses out of view scrolls to a
 * rest that shows it whole. It reports whether it has scrolled (the header's
 * shadow) and whether it runs on under the footer (the footer's cue).
 */
function PreviewBody({
  onScrolled,
  onContinues,
  children,
}: {
  onScrolled: (scrolled: boolean) => void;
  onContinues: (continues: boolean) => void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const room = useRestingBody({ body, measure: measureRests });

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) {
      return undefined;
    }
    const report = () => {
      onScrolled(element.scrollTop > 0);
      onContinues(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    report();
    element.addEventListener('scroll', report, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    observer?.observe(element);
    const content = element.firstElementChild;
    if (content !== null) {
      observer?.observe(content);
    }
    return () => {
      element.removeEventListener('scroll', report);
      observer?.disconnect();
    };
  }, [onScrolled, onContinues]);

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
