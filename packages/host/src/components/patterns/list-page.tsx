import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';

import { cn } from '../../lib/cn';
import { CloseIcon, FilterIcon } from '../ui/icons';
import { Fold } from './feed/day-fold';
import { FEED_FOCUS_RING, FEED_LINK_TEXT } from './feed/link';
import { ShowMoreButton } from './feed/show-more';

/*
 * The list page (ADR 0019, MMR-724 refinement; DESIGN.md, List page): one
 * layout for every kind of record's list (Tasks, Seeds, Artifacts, and
 * Projects). It reads top down: the count line, the search on its own row, the
 * chip row (the preset as one removable chip, then Filter, then any filter a
 * link carried), and the groups, each under a heading that stays in view while
 * its group scrolls. The feature hands it its own parts: the search box, the
 * cards or rows, and the Filter sheet. A list with nothing to search or filter
 * (Projects, MMR-790) leaves the search and chips out.
 */

/**
 * The page's frame: the count line 16 above the search, the search 8 above the
 * chips, and the chips 32 above the first group's head row, the gap between
 * groups, so the first group starts on the same beat as the rest. Without a
 * search or chips the list starts 24 below the count line.
 */
export function ListPage({
  label,
  count,
  countAction,
  search,
  chips,
  children,
}: {
  /** The list's accessible name ("Tasks"). */
  label: string;
  /** The count line, in words ("9 tasks in flight"); absent until the read arrives. */
  count?: ReactNode;
  /** A text action at the count line's right (`CountLineAction`): Seeds' File a seed. */
  countAction?: ReactNode;
  /** The search box, on its own row. */
  search?: ReactNode;
  /** The chip row's chips: the preset chip, then the Filter chip, then any carried chips. */
  chips?: ReactNode;
  children: ReactNode;
}) {
  const filtered = search !== undefined || chips !== undefined;
  return (
    // The room under the last item is Home's: 40 on a phone, the record column's
    // own bottom padding, and 48 from `md` up, 8 more than that padding.
    <section aria-label={label} className="w-full md:pb-2">
      {/* The line holds its height while the count is on its way, so nothing below moves. */}
      <div className={cn('flex min-h-5 items-center justify-between gap-3', filtered && 'mb-4')}>
        <p data-slot="list-count" className="m-0 min-w-0 text-meta text-ink-dim">
          {count}
        </p>
        {countAction}
      </div>
      {search}
      {/* On a phone each 36 pill sits in a 44 tap area; the row pulls those 4s back, so the
          pills keep the 8 and 32 and wrapped rows sit 8 apart, as the Filter sheet's pills do. */}
      {chips !== undefined && (
        <div
          data-slot="list-chips"
          className="-mb-1 mt-1 flex flex-wrap items-center gap-x-2 md:mt-2 md:mb-0 md:gap-y-2"
        >
          {chips}
        </div>
      )}
      <div data-slot="list-body" className={filtered ? 'mt-8' : 'mt-6'}>
        {children}
      </div>
    </section>
  );
}

/**
 * The count line's text action (MMR-725): a glyph and its words in the See all
 * style (13 / 20, 500, `accent-foreground`, underlined on hover), at the line's
 * right. Its tap target is 44 tall on a phone and 36 from `md` up, pulled back
 * above and below so the line keeps its 20.
 */
export function CountLineAction({
  icon,
  onClick,
  children,
}: {
  icon?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-my-3 -mr-1 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1 text-meta font-medium whitespace-nowrap md:-my-2 md:min-h-9',
        FEED_LINK_TEXT,
        FEED_FOCUS_RING,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A chip's tap area and its pill: 44 tall on a phone around a 36 pill, and 4
 * past each side, half the 8 between chips, so a tap area is at least 44 wide
 * and neighbours' areas meet without overlapping; the pill alone (36) from
 * `md` up. The pill draws the state; the button holds focus, and its ring is
 * drawn on the pill.
 */
const CHIP_TARGET = cn(
  'group/chip relative inline-flex min-h-11 items-center rounded-full outline-none md:min-h-9',
  "max-md:before:absolute max-md:before:inset-y-0 max-md:before:-inset-x-1 max-md:before:content-['']",
);
const CHIP_PILL = cn(
  'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-label whitespace-nowrap inset-ring transition-colors',
  'group-focus-visible/chip:outline-2 group-focus-visible/chip:outline-offset-2 group-focus-visible/chip:outline-solid group-focus-visible/chip:outline-accent',
);
/** A chip at rest on the page ground: an ink-dim edge, which meets 3:1 there (DESIGN.md, Color roles). */
const CHIP_OFF = 'font-medium text-ink-bright inset-ring-ink-dim group-hover/chip:bg-line/50';
/** A chip that holds a filter: the accent wash, its label at 600 so the state reads without hue. */
const CHIP_ON =
  'bg-accent/12 font-semibold text-accent-foreground inset-ring-accent group-hover/chip:bg-accent/18';

/**
 * The preset in force, as one removable chip: the whole chip is the remove
 * target, named "Remove In flight". A filter a link carries that the Filter
 * sheet does not hold takes the same chip after Filter; `children` draws its
 * label when part of it is set apart ("Tagged `workspace_unconsolidated`").
 */
export function PresetChip({
  label,
  onRemove,
  children,
}: {
  /** The chip's words, which its accessible name removes. */
  label: string;
  onRemove: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className={CHIP_TARGET}>
      <span className={cn(CHIP_PILL, CHIP_ON)}>
        <span className="max-w-[16rem] truncate">{children ?? label}</span>
        <CloseIcon className="size-4 md:size-4" />
      </span>
    </button>
  );
}

/**
 * The chip that opens the Filter sheet. With filters applied beyond the preset
 * it takes the accent wash and counts them ("Filter 2"); while the sheet is
 * open it says so (`aria-expanded`), which the wash does not stand for.
 */
export function FilterChip({
  open,
  applied,
  onClick,
  ref,
}: {
  open: boolean;
  /** How many filters apply beyond the preset. */
  applied: number;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={applied > 0 ? `Filter, ${String(applied)} applied` : 'Filter'}
      onClick={onClick}
      className={CHIP_TARGET}
    >
      <span className={cn(CHIP_PILL, applied > 0 ? CHIP_ON : CHIP_OFF)}>
        <FilterIcon className="size-4 md:size-4" />
        Filter
        {applied > 0 && <span className="text-meta">{applied}</span>}
      </span>
    </button>
  );
}

/**
 * Whether the band is pinned: stuck to the top of its scroller, which a sticky
 * band is exactly when it has moved down from its section's top. Written to the
 * band's `data-pinned` straight from the scroll, so a scroll never re-renders
 * the list.
 */
function usePinned(): RefObject<HTMLDivElement | null> {
  const band = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = band.current;
    const section = element?.parentElement;
    if (element === null || element === undefined || section === null || section === undefined) {
      return undefined;
    }
    const measure = () => {
      const pinned =
        element.getBoundingClientRect().top - section.getBoundingClientRect().top > 0.5;
      if (pinned) {
        element.dataset.pinned = '';
      } else {
        delete element.dataset.pinned;
      }
    };
    measure();
    // The scroll that moves the band is its scroller's, which a capturing
    // listener on the document hears whichever element it is.
    const doc = element.ownerDocument;
    doc.addEventListener('scroll', measure, { capture: true, passive: true });
    const view = doc.defaultView;
    view?.addEventListener('resize', measure);
    return () => {
      doc.removeEventListener('scroll', measure, { capture: true });
      view?.removeEventListener('resize', measure);
    };
  }, []);
  return band;
}

/**
 * One group of the list under its heading (the status, "In progress 3"). The
 * heading row is a band in the page's own ground that pins to the top of the
 * page's scroller while its group scrolls under it, and gains a `line`
 * hairline only while pinned; the band reaches the column's gutters, so a row
 * passing under it never shows at its sides. Groups sit 32 apart.
 */
export function ListGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const id = useId();
  const band = usePinned();
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <div
        ref={band}
        data-slot="list-group-head"
        className="sticky top-0 z-10 -mx-3.5 mb-3 bg-well-900 px-3.5 transition-shadow data-pinned:shadow-[0_1px_0_var(--color-line)] md:-mx-5 md:px-5"
      >
        <h2
          id={id}
          className="m-0 flex min-h-11 items-center gap-x-2 text-section font-semibold text-ink-bright md:min-h-9"
        >
          {title}
          {count !== undefined && ' '}
          {count !== undefined && (
            <span className="text-meta font-normal text-ink-dim">
              {count.toLocaleString('en-US')}
            </span>
          )}
        </h2>
      </div>
      {children}
    </section>
  );
}

/**
 * The folds set aside after a list's groups (Seeds' Parked and Settled, the
 * archived projects), 32 below the last group, one fold's rule above the next.
 */
export function ListFolds({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex flex-col first:mt-0">{children}</div>;
}

/** One fold of `ListFolds`: its label and count, closed until opened, what it holds inside. */
export function ListFold({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Fold label={label} count={count} open={open} onOpenChange={setOpen}>
      <div className="pt-1 pb-4">{children}</div>
    </Fold>
  );
}

/**
 * The list's one text button, closing a list that loads by window: "Show 50
 * more", the Day fold's Show N more (`ShowMoreButton`), busy while the next
 * window loads. When the last press failed, an alert above it says so, and the
 * button retries.
 */
export function ListShowMore({
  count,
  noun,
  loading,
  failed,
  onClick,
}: {
  /** How many the press reveals. */
  count: number;
  /** What it reveals, for its accessible name after the visible words ("Show 50 more finished tasks"). */
  noun: string;
  loading: boolean;
  /** Whether the last window failed to load ("Couldn't load more finished tasks."). */
  failed: boolean;
  onClick: () => void;
}) {
  return (
    <>
      {failed && (
        <p role="alert" className="mt-4 text-meta text-status-blocked-foreground">
          Couldn't load more {noun}.
        </p>
      )}
      <ShowMoreButton
        loading={loading}
        aria-label={`Show ${count.toLocaleString('en-US')} more ${noun}`}
        onClick={onClick}
        className="mt-3 px-1"
      >
        Show {count.toLocaleString('en-US')} more
      </ShowMoreButton>
    </>
  );
}
