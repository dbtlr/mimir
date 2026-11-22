import type { StatusWord } from '@mimir/contract';

import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { StatusDot } from './status-dot';

/**
 * A status word: its dot in the status hue, then its label in bright semibold
 * ink. Only the dot carries the hue, so a grey status (parked, abandoned)
 * reads as well as a bright one (ADR 0019, MMR-718).
 */
export function StatusBadge({ status, className }: { status: StatusWord; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <StatusDot status={status} />
      <span className="text-meta font-semibold text-ink-bright">{STATUS_META[status].label}</span>
    </span>
  );
}

/**
 * A record header's status line after its status: a hairline, then the
 * record's ID (mono, at the line's 13px) and type in dim ink (ADR 0019, MMR-718).
 */
export function StatusLineId({ id, type }: { id: string; type: string }) {
  return (
    <>
      <span aria-hidden className="h-3.5 w-px bg-line-bright" />
      <span className="text-meta text-ink-dim">
        <span className="font-mono">{id}</span> · {type}
      </span>
    </>
  );
}
