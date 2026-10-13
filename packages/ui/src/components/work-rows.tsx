import type { Grooming } from '@mimir/contract';
import type { ReactNode } from 'react';

import type { WireNode, WireWorkNeedsYou } from '../api/types';
import { visibleGrooming } from '../lib/grooming';
import { nodeLink } from '../lib/record-url';
import { BrowserRow } from './browser-list';
import { GroomingBadge } from './grooming-chip';
import { SizeBadge, StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';

/*
 * Task rows shared by the work page and the review page at `/`, so a task
 * that needs the operator reads the same on both.
 */

/** The attention violet belongs to the rows that need the operator (ADR 0019). */
const ATTENTION_RULE = 'border-l-2 border-attention pl-2';

/** A row's trailing chips: grooming (while it still reads one), size, and stale. */
export function RowTail({
  row,
  grooming = visibleGrooming(row),
}: {
  row: WireNode & { stale: boolean };
  grooming?: Grooming;
}) {
  return (
    <>
      {grooming !== undefined && <GroomingBadge state={grooming} />}
      {row.size != null && <SizeBadge size={row.size} />}
      {row.stale && <StaleBadge />}
    </>
  );
}

/** Why a row needs the operator: in review, a block they can clear, or a question to answer. */
function NeedsYouReason({ row }: { row: WireWorkNeedsYou }) {
  const label = {
    blocked: 'Blocked · yours',
    needs_answers: undefined,
    under_review: 'In review',
  }[row.reason];
  return label === undefined ? null : (
    <span className="microlabel text-attention-foreground">{label}</span>
  );
}

/**
 * A task that needs the operator: its reason, the hold reason on a block, and
 * the latest question on a task that needs answers. `actions` are the
 * buttons that settle it in place, when the surface offers them.
 */
export function NeedsYouRow({ row, actions }: { row: WireWorkNeedsYou; actions?: ReactNode }) {
  const holdReason = row.reason === 'blocked' ? row.hold_reason?.trim() : undefined;
  return (
    <div className={ATTENTION_RULE}>
      <BrowserRow
        to={nodeLink(row.id)}
        id={row.id}
        title={row.title}
        leading={<StatusDot status={row.status} />}
        beforeTitle={<NeedsYouReason row={row} />}
        actions={actions}
        afterTitle={
          <RowTail
            row={row}
            grooming={row.reason === 'needs_answers' ? 'needs_answers' : undefined}
          />
        }
        meta={
          <>
            {holdReason !== undefined && holdReason !== '' && (
              <p className="text-meta text-ink-dim">{holdReason}</p>
            )}
            {row.question !== null && (
              <blockquote className="mt-1 max-w-prose rounded-sm border-l-2 border-attention bg-well-850 px-2.5 py-1.5">
                <span className="microlabel block text-ink-faint">Latest question</span>
                <span className="text-meta whitespace-pre-line text-attention-foreground">
                  {row.question}
                </span>
              </blockquote>
            )}
          </>
        }
      />
    </div>
  );
}
