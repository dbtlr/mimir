import type { Lane } from '@mimir/contract';
import type { ReactNode } from 'react';

import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { overviewCardCounts } from '../lib/overview-card';
import { ago } from '../lib/time';
import { DistributionBar } from './distribution-bar';
import { StatusDot } from './status-dot';
import { Card } from './ui/card';

/**
 * One project on the Overview (MMR-226): the lane it sits in shapes the card —
 * `awaiting_you` earns a violet border + faint outer glow and a "verdict
 * waiting" signal, `needs_unsticking` a red border and a blocked count,
 * `live` a lone in-progress pip and a "moved …" recency tail in place of the
 * held figure. Row 1 is key + title + signal; row 2 the distribution bar; row 3
 * the grouped leaf counts. Off-lane (degraded / flat) cards render plain.
 */

/** Per-lane card border/glow — literal-alpha overrides called out in the brief,
 * expressed through the `attention` / `status-blocked` tokens (never raw hex). */
const LANE_CARD: Partial<Record<Lane, string>> = {
  awaiting_you:
    'border-attention/35 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-attention)_6%,transparent)]',
  needs_unsticking: 'border-status-blocked/30',
};

function laneSignal(project: WireNode, lane: Lane | undefined): ReactNode {
  const leaf = project.leaf_counts;
  if (lane === 'awaiting_you') {
    const n = leaf?.under_review ?? 0;
    return (
      <span className="ml-auto shrink-0 text-micro font-semibold text-attention-foreground">
        {n} {n === 1 ? 'verdict' : 'verdicts'} waiting
      </span>
    );
  }
  if (lane === 'needs_unsticking') {
    const n = leaf?.blocked ?? 0;
    return (
      <span className="ml-auto shrink-0 text-micro font-semibold text-status-blocked-foreground">
        {n} blocked
      </span>
    );
  }
  if (lane === 'live') {
    return <StatusDot status="in_progress" className="ml-auto size-1.5" />;
  }
  return null;
}

export function ProjectCard({
  project,
  onOpen,
  lane,
}: {
  project: WireNode;
  onOpen: (key: string) => void;
  lane?: Lane;
}) {
  const counts = overviewCardCounts(project.leaf_counts);
  // Live cards trade the held figure for a recency tail; other lanes keep held.
  const rowCounts = lane === 'live' ? counts.filter((c) => c.key !== 'held') : counts;
  const movedAt = project.attention?.last_activity;

  return (
    <Card className={cn('rounded-xl transition-colors', lane != null && LANE_CARD[lane])}>
      <button
        type="button"
        onClick={() => {
          onOpen(project.id);
        }}
        className="flex w-full flex-col gap-2.5 px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-tag text-ink-faint">{project.id}</span>
          <span className="truncate text-meta font-semibold text-ink-bright">{project.title}</span>
          {laneSignal(project, lane)}
        </div>
        <DistributionBar distribution={project.distribution ?? {}} className="h-[5px]" />
        {(rowCounts.length > 0 || (lane === 'live' && movedAt != null)) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-dim">
            {rowCounts.map((c) => (
              <span key={c.key}>
                <b className={cn('font-semibold', c.text)}>{c.count}</b> {c.label}
              </span>
            ))}
            {lane === 'live' && movedAt != null && <span>moved {ago(movedAt)}</span>}
          </div>
        )}
      </button>
    </Card>
  );
}
