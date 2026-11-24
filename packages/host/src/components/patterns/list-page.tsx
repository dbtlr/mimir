import { useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';

import { cn } from '../../lib/cn';
import { CloseIcon, FilterIcon } from '../ui/icons';
import { ShowMoreButton } from './feed/show-more';

/*
 * The list page (ADR 0019, MMR-724 refinement; DESIGN.md, List page): one
 * layout for every kind of record's list (Tasks now, then Seeds, Artifacts,
 * and Projects). It reads top down: the count line, the search on its own
 * row, the chip row (the preset as one removable chip, then Filter), and the
 * groups, each under a heading that stays in view while its group scrolls.
 * The feature hands it its own parts: the search box, the cards or rows, and
 * the Filter sheet.
 */

/**
 * The page's frame: the count line 16 above the search, the search 8 above the
 * chips, and the chips 32 above the first group's head row, the gap between
 * groups, so the first group starts on the same beat as the rest.
 */
export function ListPage({
  label,
  count,
  search,
  chips,
  children,
}: {
  /** The list's accessible name ("Tasks"). */
  label: string;
  /** The count line, in words ("9 tasks in flight"); absent until the read arrives. */
  count?: ReactNode;
  /** The search box, on its own row. */
  search: ReactNode;
  /** The chip row's chips: the preset chip, then the Filter chip. */
  chips: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="w-full">
      {/* The line holds its height while the count is on its way, so nothing below moves. */}
      <p data-slot="list-count" className="m-0 mb-4 min-h-5 text-meta text-ink-dim">
        {count}
      </p>
      {search}
      <div data-slot="list-chips" className="mt-2 flex flex-wrap items-center gap-x-2">
        {chips}
      </div>
      <div data-slot="list-body" className="mt-8">
        {children}
      </div>
    </section>
  );
}

/**
 * A chip's tap area and its pill: 44 tall on a phone around a 36 pill, and the
 * pill alone (36) from `md` up. The pill draws the state; the button holds focus,
 * and its ring is drawn on the pill.
 */
const CHIP_TARGET =
  'group/chip inline-flex min-h-11 items-center rounded-full outline-none md:min-h-9';
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
 * target, named "Remove In flight".
 */
export function PresetChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className={CHIP_TARGET}>
      <span className={cn(CHIP_PILL, CHIP_ON)}>
        <span className="max-w-[16rem] truncate">{label}</span>
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
 * The list's one text button, closing a list that loads by window: "Show 50
 * more", the Day fold's Show N more (`ShowMoreButton`), busy while the next
 * window loads.
 */
export function ListShowMore({
  count,
  noun,
  loading,
  onClick,
}: {
  /** How many the press reveals. */
  count: number;
  /** What it reveals, for its accessible name after the visible words ("Show 50 more finished tasks"). */
  noun: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <ShowMoreButton
      loading={loading}
      aria-label={`Show ${count.toLocaleString('en-US')} more ${noun}`}
      onClick={onClick}
      className="mt-3 px-1"
    >
      Show {count.toLocaleString('en-US')} more
    </ShowMoreButton>
  );
}
