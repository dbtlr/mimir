import type { StatusWord } from '@mimir/contract';

import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';

/** The status atom: a 7px dot in the status color; in-flight work pulses. */
export function StatusDot({ status, className }: { status: StatusWord; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        meta.dot,
        meta.text, // currentColor feeds the pulse glow
        status === 'in_progress' && 'animate-pulse-dot',
        className,
      )}
    />
  );
}
