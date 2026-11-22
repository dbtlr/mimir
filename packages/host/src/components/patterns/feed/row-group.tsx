import { Link } from '@tanstack/react-router';

import { cn } from '../../../lib/cn';
import { FEED_FOCUS_RING, FEED_LINK_TEXT } from './link';
import type { FeedLink } from './link';

/** One door in a row group: an optional key, a name, and its count. */
export type RowGroupRow = {
  /** A project key, set in mono in its own column. */
  key?: string;
  name: string;
  count: number;
  to: FeedLink;
};

/**
 * A row group (ADR 0019, MMR-719 refinement): compact rows that are each one
 * link, for places to go (counts by project, the "When you have a minute"
 * rows). A row counting zero is left out. A capped group ends in `more`, a row
 * of the same shape that opens the full list with a filter set.
 */
export function RowGroup({
  label,
  rows,
  more,
}: {
  /** The list's accessible name ("Shipped by project"). */
  label: string;
  rows: readonly RowGroupRow[];
  more?: { name: string; count: number; to: FeedLink };
}) {
  return (
    <ul aria-label={label} className="m-0 list-none divide-y divide-line p-0">
      {rows
        .filter((row) => row.count > 0)
        .map((row) => (
          <li key={`${row.key ?? ''}:${row.name}`}>
            <Door row={row} />
          </li>
        ))}
      {more !== undefined && more.count > 0 && (
        <li>
          <Door row={more} more />
        </li>
      )}
    </ul>
  );
}

function Door({ row, more = false }: { row: RowGroupRow; more?: boolean }) {
  return (
    <Link
      {...row.to}
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-md px-1 py-2.5 text-ink-bright no-underline md:min-h-9 md:py-1.5',
        'transition-colors hover:bg-well-800',
        FEED_FOCUS_RING,
      )}
    >
      {row.key !== undefined && (
        <span className="min-w-12 shrink-0 font-mono text-mono-id text-ink-dim">{row.key}</span>
      )}{' '}
      <span
        className={cn(
          // The clamp sits on an unpadded box, so no part of a third line shows.
          'line-clamp-2 min-w-0 flex-1 text-title font-medium wrap-anywhere',
          more ? FEED_LINK_TEXT : 'text-ink',
        )}
      >
        {row.name}
      </span>{' '}
      <span className="shrink-0 text-meta text-ink-dim">{row.count.toLocaleString('en-US')}</span>
      <svg
        aria-hidden="true"
        className="size-3.5 shrink-0 text-ink-dim"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
        viewBox="0 0 14 14"
      >
        <path d="M5 3l4 4-4 4" />
      </svg>
    </Link>
  );
}
