import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../../ui/collapsible';
import type { FeedLink } from './section-head';

/*
 * Day folds (ADR 0019, MMR-719 refinement): finished work grouped by day,
 * newest first, each day a disclosure on the Collapsible primitive that opens
 * at once, with only the latest day open. A day shows `cap` rows, then a Show N
 * more that reveals the rest in place.
 */

/**
 * One finished row: the status dot, the title (one line, demoted to ink-dim),
 * and the time in mono. `status` names the status for assistive tech when no
 * `note` carries it; an abandoned row's `note` is its status word and reason.
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
  /** The status's display label ("Done"), read before the title. */
  status: string;
  title: string;
  /** When it finished ("08:06"). */
  time: string;
  /** A second line: an abandoned row's status word and reason. */
  note?: ReactNode;
}) {
  return (
    <Link
      {...to}
      className="flex min-h-11 items-start gap-2.5 rounded-md px-1 py-2.5 no-underline transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:min-h-9 md:py-1.5"
    >
      <span className="mt-2 flex shrink-0">{dot}</span>
      <span className="min-w-0 flex-1">
        {note === undefined && <span className="sr-only">{status}:</span>}{' '}
        <span className="block truncate text-title font-medium text-ink-dim">{title}</span>
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

/** One day's fold: its trigger row and its rows, capped with an in-place Show N more. */
export function DayFold({
  label,
  count,
  rows,
  cap,
  defaultOpen = false,
}: {
  label: string;
  count: number;
  /** The day's finished rows, newest first. */
  rows: readonly ReactNode[];
  /** Rows shown before Show N more. */
  cap: number;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const justExpanded = useRef(false);
  const shown = expanded ? rows : rows.slice(0, cap);
  const hidden = rows.length - shown.length;
  // Show N more unmounts as it is pressed, which would drop focus to the page;
  // hand it to the first row it revealed.
  useEffect(() => {
    if (expanded && justExpanded.current) {
      justExpanded.current = false;
      listRef.current?.querySelectorAll('a')[cap]?.focus();
    }
  }, [expanded, cap]);
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-line not-first:border-t">
      <CollapsibleTrigger
        animated={false}
        className="min-h-11 gap-2 px-1 py-0 text-label font-medium text-ink-dim hover:text-ink md:min-h-9"
      >
        {label}{' '}
        <span className="text-meta font-normal text-ink-dim">{count.toLocaleString('en-US')}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel animated={false}>
        <ul ref={listRef} className="m-0 list-none divide-y divide-line p-0">
          {shown.map((row, index) => (
            // Rows are the caller's elements in a fixed order; position is their identity here.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index}>{row}</li>
          ))}
        </ul>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => {
              justExpanded.current = true;
              setExpanded(true);
            }}
            className="flex min-h-11 items-center rounded-md border-0 bg-transparent pr-1 pl-6 text-label font-medium text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:min-h-9"
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
  rows: readonly ReactNode[];
};

/** Days of finished work, newest first; only the latest day starts open. */
export function DayFolds({ days, cap }: { days: readonly FoldDay[]; cap: number }) {
  return (
    <div className="flex flex-col">
      {days.map((day, index) => (
        <DayFold
          key={day.key}
          label={day.label}
          count={day.count}
          rows={day.rows}
          cap={cap}
          defaultOpen={index === 0}
        />
      ))}
    </div>
  );
}
