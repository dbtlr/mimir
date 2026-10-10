import { useState } from 'react';

import type { WireHistoryEntry } from '../api/types';
import { cn } from '../lib/cn';
import { ago } from '../lib/time';
import { describeTransition } from '../lib/timeline';
import type { FeedItem } from '../lib/timeline';
import { MarkdownBody } from './markdown-body';
import type { ClampMeasure } from './markdown-body';
import { Skeleton } from './ui/skeleton';

/** Filled dot color per transition destination; unmapped destinations stay neutral. */
const TRANSITION_DOT: Record<string, string> = {
  abandoned: 'bg-status-abandoned',
  blocked: 'bg-status-blocked',
  done: 'bg-status-done',
  in_progress: 'bg-status-in-progress',
  parked: 'bg-status-parked',
  under_review: 'bg-status-under-review',
};

/** Timeline dot: filled (status-colored) for transitions/creation, outlined for notes. */
function FeedDot({ item }: { item: FeedItem }) {
  if (item.variant === 'annotation') {
    return (
      <span
        aria-hidden
        className="mt-1 size-[7px] shrink-0 rounded-full border-[1.5px] border-ink-dim bg-well-850"
      />
    );
  }
  const fill =
    item.variant === 'transition'
      ? (TRANSITION_DOT[item.entry.to ?? ''] ?? 'bg-ink-dim')
      : 'bg-ink-faint';
  return <span aria-hidden className={cn('mt-1 size-[7px] shrink-0 rounded-full', fill)} />;
}

function TransitionLine({ entry }: { entry: WireHistoryEntry }) {
  const { label, detail } = describeTransition(entry);
  return (
    <p className="text-meta text-ink">
      <span className="font-medium">{label}</span>
      {detail != null && <span className="ml-1.5 font-mono text-tag text-ink-dim">{detail}</span>}
      {entry.reason != null && <span className="text-ink-dim"> — {entry.reason}</span>}
    </p>
  );
}

/**
 * A note clamped to 3 lines. "Show all · N lines" appears only when the
 * rendered note really overflows its clamp; N is the approximate rendered
 * line count the clamp measured.
 */
function TimelineNote({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [measure, setMeasure] = useState<ClampMeasure>({ lines: 0, overflowing: false });
  const count =
    measure.lines > 0
      ? ` · ${String(measure.lines)} ${measure.lines === 1 ? 'line' : 'lines'}`
      : '';
  return (
    <div className="flex flex-col gap-0.5">
      <MarkdownBody
        breaks
        size="compact"
        clamp={expanded ? undefined : 3}
        onClampMeasure={setMeasure}
        className="max-w-none"
      >
        {content}
      </MarkdownBody>
      {measure.overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="self-start text-micro text-accent-foreground transition-colors hover:text-accent"
        >
          {expanded ? 'Show less ⌃' : `Show all${count} ⌄`}
        </button>
      )}
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  return (
    <li className="relative flex gap-2.5">
      <FeedDot item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {item.variant === 'created' && <span className="text-meta text-ink-dim">Created</span>}
        {item.variant === 'transition' && <TransitionLine entry={item.entry} />}
        {item.variant === 'annotation' && <TimelineNote content={item.content} />}
        <time className="font-mono text-micro text-ink-faint">{ago(item.at)}</time>
      </div>
    </li>
  );
}

/**
 * A node's timeline entries, oldest first — a skeleton while the first load is
 * pending, `empty` once there is nothing to show. `threaded` draws the line
 * that joins the dots, as the record page does.
 */
export function FeedList({
  items,
  pending,
  empty,
  threaded = false,
}: {
  items: readonly FeedItem[];
  pending: boolean;
  empty: string;
  threaded?: boolean;
}) {
  if (pending && items.length === 0) {
    return <Skeleton className="h-12 w-full" />;
  }
  if (items.length === 0) {
    return <p className="text-xs text-ink-faint">{empty}</p>;
  }
  return (
    <ol
      className={cn(
        'relative flex flex-col gap-3',
        // The thread runs through the dot centres (7px dots at the row's left edge).
        threaded &&
          'before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-line',
      )}
    >
      {items.map((i, idx) => (
        // Index disambiguates same-millisecond entries (two annotations can share
        // created_at), which `${variant}-${at}-${sort}` alone would collide on.
        <FeedRow key={`${i.variant}-${String(i.sort)}-${String(idx)}`} item={i} />
      ))}
    </ol>
  );
}
