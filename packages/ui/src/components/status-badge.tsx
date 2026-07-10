import type { StatusWord } from '@mimir/contract';

import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';
import { StatusDot } from './status-dot';
import { statusChipVariants } from './ui/badge';

/**
 * A status word as a wash chip — the CVA kit variant, dot + label inside.
 * `pill` swaps the board-card chip shape for the header pill idiom
 * (rounded-full, uppercase, tracked) used on the dossier header.
 */
export function StatusBadge({
  status,
  className,
  pill,
}: {
  status: StatusWord;
  className?: string;
  pill?: boolean;
}) {
  const { label } = STATUS_META[status];
  return (
    <span
      className={cn(
        statusChipVariants({ shape: pill === true ? 'pill' : 'chip', status }),
        className,
      )}
    >
      <StatusDot status={status} />
      {pill === true ? label.toUpperCase() : label}
    </span>
  );
}
