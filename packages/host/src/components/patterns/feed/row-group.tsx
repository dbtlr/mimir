import { Link } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { cardVariants } from '../../ui/card';
import { FEED_FOCUS_RING } from './link';
import type { FeedLink } from './link';

/**
 * How a row says its count, when not as the bare number: in words ("36
 * live", "Nothing live"), as the attention pill ("2 need you"), or not at all
 * (an archived project's row, MMR-790).
 */
export type RowGroupCount =
  | { kind: 'words'; text: string }
  | { kind: 'attention'; text: string }
  | { kind: 'none' };

/** One row in a row group: an optional key, a name, its count, and where it leads, if anywhere. */
export type RowGroupRow = {
  /** A project key, set in mono in its own column, unique within the group. */
  key?: string;
  /** The row's identity when its name may repeat (a record ID), unique within the group; never shown. */
  id?: string;
  /** The row's label; a row without a key needs a name unique within the group. */
  name: string;
  count: number;
  /** How the count shows; absent, the number. */
  shows?: RowGroupCount;
  /** The name set back to ink-dim: a project with nothing live, or an archived one. */
  setBack?: boolean;
  /** The row's figures under the group's columns, in their order; shown from `md` up. */
  figures?: readonly number[];
  /** The row's destination; a row without one is a plain row, not a link. */
  to?: FeedLink;
  /**
   * A mark before the name in a 16 column, from the feature: a part's status
   * dot and its status in words for a screen reader (MMR-727).
   */
  lead?: ReactNode;
};

/**
 * One count column of a group laid out in columns (MMR-790). A figure above
 * zero draws as the attention figure (the violet dot, ink-bright 600: Need
 * you), as a strong one (ink, 500: Live), or plain (ink-dim).
 */
export type RowGroupColumn = { caption: string; tone?: 'attention' | 'strong' };

/** The captions of a group laid out in columns: the key's, the name's, then each figure's. */
export type RowGroupColumns = {
  key: string;
  name: string;
  figures: readonly RowGroupColumn[];
};

/**
 * A row group (ADR 0019, MMR-719 refinement): compact rows of counts, each a
 * link when it has somewhere to go (counts by project, the "When you have a
 * minute" rows). A row with no destination is plain: no chevron, no hover
 * fill (MMR-722). A row counting zero is left out unless the group keeps it
 * (`keepZero`). A capped group ends in `more`, a row of the same shape that
 * opens the full list with a filter set. A `framed` group is a section's
 * whole block beside a framed section, in a card's frame as the Shipped
 * summary's breakdown sits in its card (MMR-722, MMR-780).
 *
 * The Projects list's options (MMR-790): a row's count `shows` in words or as
 * the attention pill, and a group with `columns` lays each row's `figures`
 * out under captions from `md` up, where they take the place of the one
 * count.
 *
 * A scoped page's options (MMR-727): a row may `lead` with a mark (a part's
 * status dot), and `after` closes the group, inside its frame, with what is
 * set apart from its rows (a Lane fold of the finished parts).
 */
export function RowGroup({
  label,
  rows,
  more,
  framed = false,
  keepZero = false,
  columns,
  after,
}: {
  /** The list's accessible name ("Shipped by project"). */
  label: string;
  rows: readonly RowGroupRow[];
  more?: { name: string; count: number; to: FeedLink };
  framed?: boolean;
  /** Keep the rows that count zero. */
  keepZero?: boolean;
  /**
   * Lay the rows out in columns. Only linked rows that carry figures and show
   * a count (not `none`) fit its tracks; a group with columns has no `more`.
   */
  columns?: RowGroupColumns;
  /** What closes the group under its last row, inside its frame (not with `columns`). */
  after?: ReactNode;
}) {
  const layout: Layout = { columns };
  const items = (
    <>
      {rows
        .filter((row) => keepZero || row.count > 0)
        .map((row) => (
          // Keyed by the row itself, so neither a row reaching zero nor a row
          // inserted or moved remounts a focused door and drops its focus.
          <li key={rowKey(row)} className={columns === undefined ? undefined : SUBGRID}>
            {row.to === undefined ? (
              <PlainRow row={row} layout={layout} />
            ) : (
              <Door row={row} to={row.to} layout={layout} />
            )}
          </li>
        ))}
      {more !== undefined && more.count > 0 && (
        <li>
          <Door row={more} to={more.to} layout={layout} more />
        </li>
      )}
    </>
  );
  if (columns !== undefined) {
    return <ColumnsGroup label={label} columns={columns} items={items} />;
  }
  // With every row set apart into `after`, an empty list would only draw a stray hairline above it.
  const empty = more === undefined && !rows.some((row) => keepZero || row.count > 0);
  const list =
    empty && after !== undefined ? null : (
      <ul aria-label={label} className="m-0 list-none divide-y divide-line p-0">
        {items}
      </ul>
    );
  if (framed) {
    return (
      <div data-slot="row-group-frame" className={cn(cardVariants(), 'px-4')}>
        {list}
        {after}
      </div>
    );
  }
  return after === undefined ? (
    list
  ) : (
    <div>
      {list}
      {after}
    </div>
  );
}

/** What a group's rows lay out by. */
type Layout = { columns?: RowGroupColumns };

/** A part that spans the group's grid and lays its children on the group's own tracks. */
const SUBGRID = 'col-span-full grid grid-cols-subgrid';

/**
 * A group laid out in columns: one grid whose tracks every row shares, so the
 * key column fits the longest key and each figure lines up under its caption.
 * Below `md` the tracks are the key, the name, the one count, and the
 * chevron; from `md` up the figures take the count's place. The caption row
 * is a band in the page's ground that pins to the top of the page's scroller
 * while the rows scroll under it, as a list group's head does; the rows name
 * their figures themselves, so a screen reader skips it.
 */
function ColumnsGroup({
  label,
  columns,
  items,
}: {
  label: string;
  columns: RowGroupColumns;
  items: ReactNode;
}) {
  const tracks: CSSProperties & Record<'--row-group-figures', number> = {
    '--row-group-figures': columns.figures.length,
  };
  return (
    <div
      data-slot="row-group-table"
      style={tracks}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-3 md:grid-cols-[auto_minmax(0,1fr)_repeat(var(--row-group-figures),minmax(5.25rem,auto))_auto]"
    >
      <div
        aria-hidden="true"
        data-slot="row-group-captions"
        className={cn(
          SUBGRID,
          // The band reaches past the 20 gutters; its hairline keeps to the column, as the rows' do.
          'sticky top-0 z-10 -mx-5 min-h-9 items-center bg-well-900 px-5 max-md:hidden',
          "after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-line after:content-['']",
          'microlabel text-ink-dim',
        )}
      >
        <span>{columns.key}</span>
        <span>{columns.name}</span>
        {columns.figures.map((figure) => (
          <span key={figure.caption} className="pl-3 text-right">
            {figure.caption}
          </span>
        ))}
        <span />
      </div>
      <ul aria-label={label} className={cn(SUBGRID, 'm-0 list-none divide-y divide-line p-0')}>
        {items}
      </ul>
    </div>
  );
}

/**
 * A row's stable React key: its identity, else its project key, else its
 * name. A row with neither has a fixed label ("Seeds to triage"), unique
 * within its group. Separate namespaces keep one kind from equalling another.
 */
function rowKey(row: RowGroupRow): string {
  if (row.id !== undefined) {
    return `id:${row.id}`;
  }
  return row.key === undefined ? `name:${row.name}` : `key:${row.key}`;
}

/** The row's height and spacing, shared by a door and a plain row. */
const ROW_HEIGHT = 'min-h-11 items-center py-2.5 md:min-h-9 md:py-1.5';

/**
 * A row's box: a flex row, or in a group laid out in columns, a row of the
 * group's grid. A columns row scrolls into view 36 clear of the pinned
 * caption band, so the band never covers a row that takes focus.
 */
function rowBox(layout: Layout): string {
  return cn(ROW_HEIGHT, layout.columns === undefined ? 'flex gap-3' : [SUBGRID, 'md:scroll-mt-9']);
}

/** The violet dot of the attention hue, before a count that needs you. */
function AttentionDot({ size }: { size: 'pill' | 'figure' }) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 rounded-full bg-attention', size === 'pill' ? 'size-1.5' : 'size-2')}
    />
  );
}

/** The row's one count: the number, its words, or the attention pill. */
function Count({ row, columns }: { row: RowGroupRow; columns: boolean }) {
  const shows = row.shows;
  // With columns, the figures take the count's place from md up.
  const phoneOnly = columns && 'md:hidden';
  if (shows?.kind === 'none') {
    return null;
  }
  if (shows?.kind === 'attention') {
    return (
      <span
        data-slot="row-attention"
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 justify-self-end rounded-full bg-attention/12 px-2 text-xs leading-5 font-semibold whitespace-nowrap text-attention-foreground inset-ring inset-ring-attention/24',
          phoneOnly,
        )}
      >
        <AttentionDot size="pill" />
        {shows.text}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'shrink-0 text-meta text-ink-dim',
        // The Projects list's counts keep to one line, set right in the count track.
        (columns || shows !== undefined) && 'text-right whitespace-nowrap tabular-nums',
        phoneOnly,
      )}
    >
      {shows?.kind === 'words' ? shows.text : row.count.toLocaleString('en-US')}
    </span>
  );
}

/**
 * The row's figures under the group's columns, from `md` up. A zero is an en
 * dash in ink-dim. A screen reader skips the painted figure and hears each one
 * once, named for its caption ("0 going cold").
 */
function Figures({ row, columns }: { row: RowGroupRow; columns: RowGroupColumns }) {
  return columns.figures.map((column, i) => {
    const value = row.figures?.[i] ?? 0;
    const tone = value > 0 ? column.tone : undefined;
    return (
      <span
        key={column.caption}
        data-slot="row-figure"
        data-tone={tone}
        className={cn(
          // 12 of lead room past the track's gap, so a wide caption still stands clear of the one before.
          'flex items-center justify-end gap-1.5 pl-3 text-meta tabular-nums max-md:hidden',
          tone === undefined && 'text-ink-dim',
          tone === 'strong' && 'font-medium text-ink',
          tone === 'attention' && 'font-semibold text-ink-bright',
        )}
      >
        {tone === 'attention' && <AttentionDot size="figure" />}
        <span aria-hidden="true">{value > 0 ? value.toLocaleString('en-US') : '–'}</span>
        <span className="sr-only">{`, ${value.toLocaleString('en-US')} ${column.caption.toLowerCase()}`}</span>
      </span>
    );
  });
}

/** A row's key, name, and count, in that order, and its figures when the group has columns. */
function RowText({
  row,
  layout,
  more = false,
}: {
  row: RowGroupRow;
  layout: Layout;
  more?: boolean;
}): ReactNode {
  const { columns } = layout;
  let ink = 'text-ink';
  if (more) {
    // The door's underline answers a hover anywhere on its row.
    ink = 'text-accent-foreground group-hover:underline';
  } else if (row.setBack === true) {
    ink = 'text-ink-dim';
  }
  return (
    <>
      {row.lead !== undefined && (
        <>
          {/* Centred on the name's first line, as the Day fold's dot column is. */}
          <span className="flex w-4 shrink-0 justify-center self-start pt-2">{row.lead}</span>{' '}
        </>
      )}
      {(row.key !== undefined || columns !== undefined) && (
        <>
          <span className="min-w-12 shrink-0 font-mono text-mono-id text-ink-dim">
            {row.key}
          </span>{' '}
        </>
      )}
      <span
        className={cn(
          // The clamp sits on an unpadded box, so no part of a third line shows.
          'line-clamp-2 min-w-0 flex-1 text-title font-medium wrap-anywhere',
          columns !== undefined && 'md:text-balance',
          ink,
        )}
      >
        {row.name}
      </span>
      {row.shows?.kind !== 'none' && ' '}
      <Count row={row} columns={columns !== undefined} />
      {columns !== undefined && <Figures row={row} columns={columns} />}
    </>
  );
}

function PlainRow({ row, layout }: { row: RowGroupRow; layout: Layout }) {
  return (
    <div className={rowBox(layout)}>
      <RowText row={row} layout={layout} />
    </div>
  );
}

function Door({
  row,
  to,
  layout,
  more = false,
}: {
  row: RowGroupRow;
  to: FeedLink;
  layout: Layout;
  more?: boolean;
}) {
  return (
    <Link
      {...to}
      className={cn(
        // -mx-1 with px-1: the text sits on the column's edge while the hover
        // fill and focus ring reach 4 past it; the hairlines stay in the column.
        rowBox(layout),
        'group -mx-1 rounded-md px-1 text-ink-bright no-underline',
        'transition-colors hover:bg-well-800',
        FEED_FOCUS_RING,
      )}
    >
      <RowText row={row} layout={layout} more={more} />
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
