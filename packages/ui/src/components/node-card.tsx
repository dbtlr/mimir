import type { CSSProperties, ReactNode } from 'react';

import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { PriorityBadge, SizeBadge, StaleBadge } from './signal-badges';
import { TransitionMenu } from './transition-menu';
import { Badge } from './ui/badge';

const SHOWN_TAGS = 3;

/** Drag wiring injected by the board's SortableCard (absent in non-rankable columns). */
export type CardSortable = {
  setNodeRef: (el: HTMLElement | null) => void;
  handleProps: Record<string, unknown>;
  style?: CSSProperties;
  isDragging?: boolean;
};

/**
 * One board card. The title region opens the drawer; the kebab runs the legal
 * transitions; an optional grip handle (rankable columns only) is the sole drag
 * source — so list scroll and taps never read as a drag. Offline inerts both.
 */
export function NodeCard({
  node,
  onOpen,
  offline,
  sortable,
  ancestry,
}: {
  node: WireNode;
  onOpen: (id: string) => void;
  offline?: boolean;
  sortable?: CardSortable;
  /** `initiative › phase` breadcrumb locating this card in the tree. */
  ancestry?: string;
}) {
  const tags = node.tags ?? [];
  const overflow = tags.length - SHOWN_TAGS;
  const grip: ReactNode =
    sortable !== undefined && offline !== true ? (
      <button
        type="button"
        aria-label="Reorder"
        className="hidden cursor-grab touch-none rounded px-1 text-xs leading-none text-ink-faint hover:text-ink active:cursor-grabbing md:inline-block"
        {...sortable.handleProps}
      >
        ⠿
      </button>
    ) : null;

  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={cn(
        'group relative rounded-sm border border-line border-l-[3px] bg-well-850 p-2 transition-colors md:border-l-2',
        'hover:border-line-bright hover:bg-well-800',
        STATUS_META[node.status].border,
        sortable?.isDragging === true && 'opacity-50',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-ink-dim md:text-3xs">{node.id}</span>
        <div className="flex items-center gap-1">
          {node.verdicts?.stale === true && <StaleBadge />}
          {grip}
          <TransitionMenu node={node} disabled={offline} />
        </div>
      </div>
      {ancestry !== undefined && ancestry !== '' && (
        <p className="truncate text-2xs text-ink-faint md:text-3xs" title={ancestry}>
          {ancestry}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          onOpen(node.id);
        }}
        className="mt-0.5 block w-full text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <p className="line-clamp-2 text-md font-semibold leading-snug text-ink-bright group-hover:text-ink-bright md:text-xs md:font-medium md:text-ink">
          {node.title}
        </p>
        {node.summary != null && node.summary !== '' && (
          <p className="truncate text-2xs text-ink-dim md:text-3xs">{node.summary}</p>
        )}
      </button>
      {(node.priority != null || node.size != null || tags.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1 md:mt-1.5">
          {node.priority != null && <PriorityBadge priority={node.priority} />}
          {node.size != null && <SizeBadge size={node.size} />}
          {tags.slice(0, SHOWN_TAGS).map((t) => (
            <Badge key={t.tag} variant="outline" className="max-w-28 truncate">
              {t.tag}
            </Badge>
          ))}
          {overflow > 0 && <Badge variant="outline">+{overflow}</Badge>}
        </div>
      )}
    </div>
  );
}
