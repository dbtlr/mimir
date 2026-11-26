import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactElement, ReactNode, Ref } from 'react';

import { cn } from '../../../lib/cn';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../../ui/collapsible';
import { FEED_FOCUS_RING } from './link';
import type { FeedLink } from './link';
import { ShowMoreButton } from './show-more';

/*
 * Day folds (ADR 0019, MMR-719 refinement): finished work grouped by day,
 * newest first, each day a disclosure on the Collapsible primitive that opens
 * at once, with only the latest day open. A day shows `cap` rows, then a Show N
 * more that reveals the rest in place; a row that holds focus stays shown when
 * a refetch pushes it past the cap.
 */

/** What every finished row has: its link, title, and time. */
type FinishedRowBase = {
  to: FeedLink;
  title: string;
  /** When it finished, or was frozen ("08:06"). */
  time: string;
};

/**
 * One finished row: the status dot, the title (demoted to ink-dim, two lines
 * at most on a phone and one on desktop), and the time in mono. `status` leads
 * the row's accessible name on every row, so done and abandoned rows read
 * alike. An abandoned row's `note` is its second line: the feature's
 * StatusWord, then the reason.
 *
 * The `artifact` option (MMR-725) is a record frozen that day rather than work
 * that finished: no dot, its title in ink-bright, wrapping, and `meta` as a
 * second line that keeps to one (the kind, then the records it is on).
 */
export function FinishedRow(
  props: FinishedRowBase &
    (
      | {
          variant?: 'finished';
          /** The status dot, from the feature. */
          dot: ReactNode;
          /** The status's display label ("Done", "Abandoned"), read before the title. */
          status: string;
          /** A second line: an abandoned row's status word and its reason. */
          note?: ReactNode;
        }
      | {
          variant: 'artifact';
          /** The one meta line; the caller keeps it to one line's content. */
          meta?: ReactNode;
        }
    ),
) {
  const artifact = props.variant === 'artifact';
  const second = artifact ? props.meta : props.note;
  return (
    <Link
      {...props.to}
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
        {artifact ? null : props.dot}
      </span>
      <span className="min-w-0 flex-1">
        {!artifact && (
          <>
            <span className="sr-only">{props.status}:</span>{' '}
          </>
        )}
        <span
          className={cn(
            'block text-title font-medium wrap-anywhere',
            artifact
              ? 'text-ink-bright'
              : 'truncate text-ink-dim max-md:line-clamp-2 max-md:whitespace-normal',
          )}
        >
          {props.title}
        </span>
        {second !== undefined && (
          <>
            {' '}
            <span
              className={cn(
                'mt-0.5 block text-meta text-ink-dim',
                artifact && 'flex min-w-0 items-baseline gap-2 whitespace-nowrap',
              )}
            >
              {second}
            </span>
          </>
        )}
      </span>{' '}
      <span className="shrink-0 font-mono text-meta leading-[22px] text-ink-dim">{props.time}</span>
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

/**
 * A thread's list: 4 under the trigger, 12 before the next fold, and a
 * `line-bright` line from 14 below the list's top to 14 above its bottom,
 * through the middle of the rows' 16 dot column.
 */
const THREAD_CLASS =
  'relative mt-1 mb-3 before:absolute before:top-3.5 before:bottom-3.5 before:left-[7.5px] before:w-px before:bg-line-bright';

/** One day's fold: its trigger row and its rows, capped with an in-place Show N more. */
export function DayFold({
  label,
  count,
  rows,
  cap,
  open,
  onOpenChange,
  thread = false,
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
  /**
   * Rows shown before Show N more. A row that holds focus, pushed past the cap
   * by a refetch, stays shown with the rows above it until focus leaves the
   * fold.
   */
  cap: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rows hang on one thread through their dots, a record's timeline (MMR-728). */
  thread?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // How many rows were shown when Show N more was pressed, until the effect
  // below moves focus past them; null otherwise.
  const shownWhenPressed = useRef<number | null>(null);
  // The key of the row that holds focus. A refetch that adds newer rows pushes
  // the rest down; the shown rows reach as far as the focused one, so it stays
  // mounted and focus stays on it rather than falling to the page.
  const [focusedKey, setFocusedKey] = useState<ReactElement['key']>(null);
  const focusedAt = rows.findIndex((row) => focusedKey !== null && row.key === focusedKey);
  // A refetch that drops the focused row ends its hold, so the record's return
  // in a later refetch does not show it past the cap with nothing focused.
  if (focusedKey !== null && focusedAt === -1) {
    setFocusedKey(null);
  }
  const shown = expanded ? rows : rows.slice(0, Math.max(cap, focusedAt + 1));
  const hidden = rows.length - shown.length;
  // Show N more unmounts as it is pressed, which would drop focus to the page;
  // hand it to the first row it revealed.
  useEffect(() => {
    if (expanded && shownWhenPressed.current !== null) {
      // The first revealed row that holds something focusable; when none
      // does, the fold's trigger, so focus never falls to the page.
      const revealed = [...(listRef.current?.children ?? [])].slice(shownWhenPressed.current);
      shownWhenPressed.current = null;
      if (!revealed.some((row) => focusFirst(row))) {
        triggerRef.current?.focus();
      }
    }
  }, [expanded]);
  return (
    <Fold
      label={label}
      count={count}
      open={open}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
      panel={{
        // The hold lasts while focus stays in the fold: moving to Show N more
        // keeps the row, so the button neither shifts under a press nor
        // changes its label under focus.
        onBlur: (event) => {
          // The window losing focus (switching apps or tabs) blurs the link
          // with no relatedTarget; keep the row, so focus returns to it when
          // the window does.
          if (event.relatedTarget === null && !document.hasFocus()) {
            return;
          }
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusedKey(null);
          }
        },
      }}
    >
      <ul
        ref={listRef}
        className={cn('m-0 list-none p-0', thread ? THREAD_CLASS : 'divide-y divide-line')}
      >
        {shown.map((row) => (
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- it only notes which row holds focus; the row's own link stays the control
          <li
            key={row.key}
            className={cn(thread && 'py-1.5 md:py-[5px]')}
            onFocus={() => {
              setFocusedKey(row.key);
            }}
          >
            {row}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <ShowMoreButton
          // A mouse press leaves focus where it is. Otherwise the press
          // blurs a held row (to the page in Safari and Firefox, or out of
          // another day's fold), the row lets go, and the button moves up
          // a row before the click lands. The reveal moves focus after.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            shownWhenPressed.current = shown.length;
            setExpanded(true);
          }}
          // Indented to the titles' left edge: 4 of padding, the 16 dot
          // column, and its 8 gap.
          className="pr-1 pl-7"
        >
          Show {hidden} more
        </ShowMoreButton>
      )}
    </Fold>
  );
}

/**
 * A fold (ADR 0019, MMR-719 refinement): a trigger row, the Collapsible
 * primitive's 16 chevron, the label, and its count, 44 tall on a phone and 36
 * on desktop, over what it holds. It opens at once, with none of the
 * primitive's height animation or chevron turn (ADR 0019 §8). A day's fold
 * holds its rows; the Seeds list's Parked and Settled lanes hold their cards
 * (MMR-725).
 */
export function Fold({
  label,
  count,
  open,
  onOpenChange,
  triggerRef,
  panel,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Handlers on the panel that holds `children`. */
  panel?: Pick<ComponentProps<typeof CollapsiblePanel>, 'onBlur'>;
  children: ReactNode;
}) {
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
      <CollapsiblePanel animated={false} {...panel}>
        {children}
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
 * start over: the new day opens and the others close. `thread` hangs each
 * day's rows on one thread, as a record's timeline does (MMR-728), and draws
 * a hairline above the first day too, closing off what sits above the days.
 */
export function DayFolds({
  days,
  cap,
  thread = false,
}: {
  days: readonly FoldDay[];
  cap: number;
  thread?: boolean;
}) {
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
    <div className={cn('flex flex-col', thread && 'border-t border-line')}>
      {days.map((day) => (
        <DayFold
          key={day.key}
          label={day.label}
          count={day.count}
          rows={day.rows}
          cap={cap}
          thread={thread}
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
