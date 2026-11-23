import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { cardVariants } from '../../ui/card';
import { FEED_FOCUS_RING } from './link';
import type { FeedLink } from './link';

/** One row in a row group: an optional key, a name, its count, and where it leads, if anywhere. */
export type RowGroupRow = {
  /** A project key, set in mono in its own column, unique within the group. */
  key?: string;
  /** The row's label; a row without a key needs a name unique within the group. */
  name: string;
  count: number;
  /** The row's destination; a row without one is a plain row, not a link. */
  to?: FeedLink;
};

/**
 * A row group (ADR 0019, MMR-719 refinement): compact rows of counts, each a
 * link when it has somewhere to go (counts by project, the "When you have a
 * minute" rows). A row with no destination is plain: no chevron, no hover
 * fill (MMR-722). A row counting zero is left out. A capped group ends in
 * `more`, a row of the same shape that opens the full list with a filter set.
 * A `framed` group stands alone on a page in a card's frame, as the Shipped
 * summary's breakdown sits in its card (MMR-722, MMR-s110).
 */
export function RowGroup({
  label,
  rows,
  more,
  framed = false,
}: {
  /** The list's accessible name ("Shipped by project"). */
  label: string;
  rows: readonly RowGroupRow[];
  more?: { name: string; count: number; to: FeedLink };
  framed?: boolean;
}) {
  const list = (
    <ul aria-label={label} className="m-0 list-none divide-y divide-line p-0">
      {rows
        .filter((row) => row.count > 0)
        .map((row) => (
          // Keyed by the row itself, so neither a row reaching zero nor a row
          // inserted or moved remounts a focused door and drops its focus.
          <li key={rowKey(row)}>
            {row.to === undefined ? <PlainRow row={row} /> : <Door row={row} to={row.to} />}
          </li>
        ))}
      {more !== undefined && more.count > 0 && (
        <li>
          <Door row={more} to={more.to} more />
        </li>
      )}
    </ul>
  );
  return framed ? (
    <div data-slot="row-group-frame" className={cn(cardVariants(), 'px-4')}>
      {list}
    </div>
  ) : (
    list
  );
}

/**
 * A row's stable React key: its project key, else its name. An unkeyed row's
 * name is a fixed label ("Seeds to triage"), unique within its group. Two
 * namespaces keep a caller's key from ever equalling a name.
 */
function rowKey(row: RowGroupRow): string {
  return row.key === undefined ? `name:${row.name}` : `key:${row.key}`;
}

/** The row's height and spacing, shared by a door and a plain row. */
const ROW = 'flex min-h-11 items-center gap-3 py-2.5 md:min-h-9 md:py-1.5';

/** A row's key, name, and count, in that order. */
function RowText({ row, more = false }: { row: RowGroupRow; more?: boolean }): ReactNode {
  return (
    <>
      {row.key !== undefined && (
        <span className="min-w-12 shrink-0 font-mono text-mono-id text-ink-dim">{row.key}</span>
      )}{' '}
      <span
        className={cn(
          // The clamp sits on an unpadded box, so no part of a third line shows.
          'line-clamp-2 min-w-0 flex-1 text-title font-medium wrap-anywhere',
          // The door's underline answers a hover anywhere on its row.
          more ? 'text-accent-foreground group-hover:underline' : 'text-ink',
        )}
      >
        {row.name}
      </span>{' '}
      <span className="shrink-0 text-meta text-ink-dim">{row.count.toLocaleString('en-US')}</span>
    </>
  );
}

function PlainRow({ row }: { row: RowGroupRow }) {
  return (
    <div className={ROW}>
      <RowText row={row} />
    </div>
  );
}

function Door({ row, to, more = false }: { row: RowGroupRow; to: FeedLink; more?: boolean }) {
  return (
    <Link
      {...to}
      className={cn(
        // -mx-1 with px-1: the text sits on the column's edge while the hover
        // fill and focus ring reach 4 past it; the hairlines stay in the column.
        ROW,
        'group -mx-1 rounded-md px-1 text-ink-bright no-underline',
        'transition-colors hover:bg-well-800',
        FEED_FOCUS_RING,
      )}
    >
      <RowText row={row} more={more} />
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
