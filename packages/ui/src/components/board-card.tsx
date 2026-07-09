import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';

import { useTransition } from '../api/mutations';
import type { WireNode } from '../api/types';
import type { SwimlaneColumn } from '../lib/bands';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { ReasonDialog } from './reason-dialog';
import { PriorityBadge, SizeBadge } from './signal-badges';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';
import { cardVariants } from './ui/card';

const SHOWN_TAGS = 3;

/** Drag wiring injected by the swimlane's SortableCard (rankable columns only). */
export type CardSortable = {
  setNodeRef: (el: HTMLElement | null) => void;
  handleProps: Record<string, unknown>;
  style?: CSSProperties;
  isDragging?: boolean;
};

const RELEASE_PREFIX = 'release:';

/**
 * A `release:*` tag as the teal-accent wash (MMR-221 §2.5) — the visible signal
 * that a Release band claimed the row, distinct from the neutral outline chips.
 * The canonical wash idiom: `/12` accent fill under a `/24` inset ring.
 */
function ReleaseTag({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-[4px] bg-accent/12 px-[7px] py-0.5 font-mono text-micro text-accent-foreground inset-ring inset-ring-accent/24">
      {value}
    </span>
  );
}

/**
 * One swimlane card (MMR-221 §2.5). Four treatments over one anatomy: the
 * default live card, the under-review verdict card (violet ring + Approve/
 * Return, wired to the real `done`/`return` verbs), the recessed Done card, and
 * the inline cold marker on a stale non-terminal card. The title opens the
 * drawer; a grip (rankable columns) is the sole drag source. Offline inerts the
 * verb buttons but never the open/drag affordances.
 */
export function BoardCard({
  node,
  column,
  onOpen,
  offline,
  sortable,
}: {
  node: WireNode;
  column: SwimlaneColumn;
  onOpen: (id: string) => void;
  offline?: boolean;
  sortable?: CardSortable;
}) {
  const { mutate } = useTransition(node.id);
  const [returning, setReturning] = useState(false);

  const isDone = column === 'done';
  const isUnderReview = column === 'under_review';
  const isCold = !isDone && !isUnderReview && node.verdicts?.stale === true;

  const tags = node.tags ?? [];
  const overflow = tags.length - SHOWN_TAGS;

  const grip: ReactNode =
    sortable !== undefined && offline !== true ? (
      <button
        type="button"
        aria-label="Reorder"
        className="cursor-grab touch-none rounded px-0.5 text-xs leading-none text-ink-faint hover:text-ink active:cursor-grabbing"
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
        cardVariants({ variant: isDone ? 'recessed' : 'default' }),
        'group flex flex-col gap-1.5 rounded-[9px] px-[13px] py-[11px] transition-colors',
        !isDone && `border-l-2 ${STATUS_META[node.status].border} hover:border-line-bright`,
        isUnderReview &&
          'border-attention/40 dark:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-attention)_10%,transparent)]',
        isDone && 'opacity-80',
        sortable?.isDragging === true && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn('font-mono text-mono-id', isDone ? 'text-ink-ghost' : 'text-ink-faint')}
        >
          {node.id}
        </span>
        {isUnderReview ? (
          <span className="font-bold tracking-[0.08em] text-attention-foreground [font-size:9px]">
            NEEDS VERDICT
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            {isCold && <span className="font-mono text-mono-id text-cold">⧗ cold</span>}
            {grip}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          onOpen(node.id);
        }}
        className="block w-full text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <p
          className={cn(
            'text-body leading-[1.45] font-medium',
            isDone || isCold ? 'text-ink-dim' : 'text-ink-bright',
          )}
        >
          {node.title}
        </p>
      </button>

      {(node.priority != null || node.size != null || tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {node.priority != null && <PriorityBadge priority={node.priority} />}
          {node.size != null && <SizeBadge size={node.size} />}
          {tags.slice(0, SHOWN_TAGS).map((t) =>
            t.tag.startsWith(RELEASE_PREFIX) ? (
              <ReleaseTag key={t.tag} value={t.tag.slice(RELEASE_PREFIX.length)} />
            ) : (
              <Badge key={t.tag} variant="outline" className="max-w-28 truncate">
                {t.tag}
              </Badge>
            ),
          )}
          {overflow > 0 && <Badge variant="outline">+{overflow}</Badge>}
        </div>
      )}

      {isUnderReview && (
        <div className="mt-0.5 flex gap-2">
          <ActionButton
            variant="attention"
            size="sm"
            disabled={offline}
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              mutate({ verb: 'done' });
            }}
          >
            Approve
          </ActionButton>
          <ActionButton
            variant="outline"
            size="sm"
            disabled={offline}
            className="flex-1 text-ink-dim"
            onClick={(e) => {
              e.stopPropagation();
              setReturning(true);
            }}
          >
            Return…
          </ActionButton>
          <ReasonDialog
            verb={returning ? 'return' : null}
            open={returning}
            onClose={() => {
              setReturning(false);
            }}
            onConfirm={(reason) => {
              mutate(reason === '' ? { verb: 'return' } : { reason, verb: 'return' });
              setReturning(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
