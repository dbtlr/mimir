import type { StatusWord } from '@mimir/contract';

import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { StatusDot } from './status-dot';
import { statusChipVariants } from './ui/badge';

/** A status word as a wash chip — the CVA kit variant, dot + label inside. */
export function StatusBadge({ status, className }: { status: StatusWord; className?: string }) {
  return (
    <span className={cn(statusChipVariants({ status }), className)}>
      <StatusDot status={status} />
      {STATUS_META[status].label}
    </span>
  );
}
