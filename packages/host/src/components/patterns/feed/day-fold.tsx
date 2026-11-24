import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../../ui/collapsible';
import { FEED_FOCUS_RING, FEED_LINK_TEXT } from './link';
import type { FeedLink } from './link';

/*
 * Day folds (ADR 0019, MMR-719 refinement): finished work grouped by day,
 * newest first, each day a disclosure on the Collapsible primitive that opens
 * at once, with only the latest day open. A day shows `cap` rows, then a Show N
 * more that reveals the rest in place.
 */

/**
 * One finished row: the status dot, the title (demoted to ink-dim, two lines
 * at most on a phone and one on desktop), and the time in mono. `status` leads
 * the row's accessible name on every row, so done and abandoned rows read
 * alike. An abandoned row's `note` is its second line: the feature's
 * StatusWord, then the reason.
 */
export function FinishedRow({
  to,
  dot,
  status,
  title,
  time,
  note,
}: {
  to: FeedLink;
  /** The status dot, from the feature. */
  dot: ReactNode;
  /** The status's display label ("Done", "Abandoned"), read before the title. */
  status: string;
  title: string;
  /** When it finished ("08:06"). */
  time: string;
  /** A second line: an abandoned row's status word and its reason. */
  note?: ReactNode;
}) {
  return (
    <Link
      {...to}
      className={cn(
        // -mx-1 with px-1: the text sits on the column's edge while the hover
        // fill and focus ring reach 4 past it; the hairlines stay in the column.
        '-mx-1 flex min-h-11 items-start gap-2 rounded-md px-1 py-2.5 no-underline transition-colors hover:bg-well-800 md:min-h-9 md:py-1.5',
        FEED_FOCUS_RING,
      )}
    >
      {/* The dot sits in a 16 column, as the fold's chevron does, so the title
          lines up with the day label. It is hidden: the status is in words. */}
      <span aria-hidden className="mt-2 flex w-4 shrink-0 justify-center">
        {dot}
      </span>
      <span className="min-w-0 flex-1">
        <span className="sr-only">{status}:</span>{' '}
        <span className="block truncate text-title font-medium text-ink-dim wrap-anywhere max-md:line-clamp-2 max-md:whitespace-normal">
          {title}
        </span>
        {note !== undefined && (
          <>
            {' '}
            <span className="mt-0.5 block text-meta text-ink-dim">{note}</span>
          </>
        )}
      </span>{' '}
      <span className="shrink-0 font-mono text-meta leading-[22px] text-ink-dim">{time}</span>
    </Link>
  );
}

/** What may take focus in a revealed row, before `focusFirst` tries each. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * Moves focus to the first element in `root` that is in the tab order and
 * actually takes focus. Each candidate is tried in turn, so whatever makes an
 * element refuse focus (disabled, a disabled fieldset, hidden, `display:
 * none`) passes it over without being listed here.
 */
function focusFirst(root: Element | undefined): boolean {
  for (const element of root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []) {
    if (element.tabIndex < 0 || element.matches(':disabled')) {
      continue;
    }
    element.focus();
    if (document.activeElement === element) {
      return true;
    }
  }
  return false;
}

/** One day's fold: its trigger row and its rows, capped with an in-place Show N more. */
export function DayFold({
  label,
  count,
  rows,
  cap,
  open,
  onOpenChange,
}: {
  label: string;
  /**
   * How many finished that day. It may exceed `rows` when a page loads only
   * part of the day; Show N more counts only the rows it was given.
   */
  count: number;
  /**
   * The day's finished rows, newest first, each an element keyed by its
   * record's ID, so a refetch that adds a row keeps every other row (and the
   * focus on it) attached to its own record.
   */
  rows: readonly ReactElement[];
  /** Rows shown before Show N more. */
  cap: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const justExpanded = useRef(false);
  const shown = expanded ? rows : rows.slice(0, cap);
  const hidden = rows.length - shown.length;
  // Show N more unmounts as it is pressed, which would drop focus to the page;
  // hand it to the first row it revealed.
  useEffect(() => {
    if (expanded && justExpanded.current) {
      justExpanded.current = false;
      // The first revealed row that holds something focusable; when none
      // does, the fold's trigger, so focus never falls to the page.
      const revealed = [...(listRef.current?.children ?? [])].slice(cap);
      if (!revealed.some((row) => focusFirst(row))) {
        triggerRef.current?.focus();
      }
    }
  }, [expanded, cap]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
      className="border-line not-first:border-t"
    >
      <CollapsibleTrigger
        ref={triggerRef}
        animated={false}
        // Like a row: the ring drawn inside, and a fill on hover.
        className="-mx-1 min-h-11 w-[calc(100%+0.5rem)] gap-2 px-1 py-0 text-label font-medium text-ink hover:bg-well-800 hover:text-ink-bright focus-visible:-outline-offset-2 md:min-h-9"
      >
        {label}{' '}
        <span className="text-meta font-normal text-ink-dim">{count.toLocaleString('en-US')}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel animated={false}>
        <ul ref={listRef} className="m-0 list-none divide-y divide-line p-0">
          {shown.map((row) => (
            <li key={row.key}>{row}</li>
          ))}
        </ul>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => {
              justExpanded.current = true;
              setExpanded(true);
            }}
            // Pulled 4 left like the rows, then indented to the titles' left
            // edge: 4 of padding, the 16 dot column, and its 8 gap.
            className={cn(
              '-ml-1 flex min-h-11 items-center rounded-md border-0 bg-transparent pr-1 pl-7 text-label font-medium md:min-h-9',
              FEED_LINK_TEXT,
              FEED_FOCUS_RING,
            )}
          >
            Show {hidden} more
          </button>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** A day's fold in a list of days. */
export type FoldDay = {
  /** A stable key, such as the day's date. */
  key: string;
  label: string;
  count: number;
  /** The day's rows, each an element keyed by its record's ID. */
  rows: readonly ReactElement[];
};

/**
 * Days of finished work, newest first; only the latest day starts open. When a
 * new latest day arrives (the day rolls over and a refetch adds it), the folds
 * start over: the new day opens and the others close.
 */
export function DayFolds({ days, cap }: { days: readonly FoldDay[]; cap: number }) {
  const latest = days[0]?.key;
  const [openFor, setOpenFor] = useState(latest);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(latest === undefined ? [] : [latest]),
  );
  // Adjusting state while rendering, React's pattern for state derived from a
  // prop: a new latest day resets which folds are open.
  if (openFor !== latest) {
    setOpenFor(latest);
    setOpen(new Set(latest === undefined ? [] : [latest]));
  }
  return (
    <div className="flex flex-col">
      {days.map((day) => (
        <DayFold
          key={day.key}
          label={day.label}
          count={day.count}
          rows={day.rows}
          cap={cap}
          open={open.has(day.key)}
          onOpenChange={(next) => {
            setOpen((current) => {
              const updated = new Set(current);
              if (next) {
                updated.add(day.key);
              } else {
                updated.delete(day.key);
              }
              return updated;
            });
          }}
        />
      ))}
    </div>
  );
}
