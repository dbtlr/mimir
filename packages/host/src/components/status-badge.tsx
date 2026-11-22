import type { SeedLane, StatusWord as Status } from '@mimir/contract';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { SEED_LANE_DOT } from '../lib/seed-lanes';
import { STATUS_META } from '../lib/status';
import { StatusDot } from './status-dot';

/**
 * The word of a status, or of a word that stands beside one (a seed's lane):
 * bright semibold ink at the meta size. The hue never sits on the word, only on
 * the dot before it (ADR 0019, MMR-718).
 */
export function StatusWord({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-meta font-semibold text-ink-bright', className)}>{children}</span>
  );
}

/**
 * A status word: its dot in the status hue, then its label in bright semibold
 * ink. Only the dot carries the hue, so a grey status (parked, abandoned)
 * reads as well as a bright one (ADR 0019, MMR-718). `label` replaces the
 * display label with a standing such as "Done 2026-11-21".
 */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: Status;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <StatusDot status={status} />
      <StatusWord>{label ?? STATUS_META[status].label}</StatusWord>
    </span>
  );
}

/** A seed's lane, read like a status: a dot in the lane's hue, then its word in bright ink. */
export function LaneBadge({ lane, label }: { lane: SeedLane; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        className={cn('inline-block size-[7px] shrink-0 rounded-full', SEED_LANE_DOT[lane])}
      />
      <StatusWord>{label}</StatusWord>
    </span>
  );
}

/**
 * A record header's ID and type: the ID in mono at the line's 13px, then the
 * type word, in dim ink (ADR 0019, MMR-718). After a status it follows a
 * hairline; a header that does not lead with a status passes `hairline={false}`.
 */
export function StatusLineId({
  id,
  type,
  hairline = true,
}: {
  id: string;
  type: string;
  hairline?: boolean;
}) {
  return (
    <>
      {hairline && <span aria-hidden className="h-3.5 w-px bg-line-bright" />}
      <span className="text-meta text-ink-dim">
        <span className="font-mono">{id}</span> · {type}
      </span>
    </>
  );
}
