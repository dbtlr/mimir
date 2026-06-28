import type { Priority, Size } from '@mimir/contract';

import { cn } from '../lib/cn';
import { Badge } from './ui/badge';

/** Priority signal chip — p0 burns hottest; a signal, never a sort (ADR 0007). */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge
      variant="mono"
      className={cn(
        priority === 'p0' && 'bg-status-blocked/20 text-status-blocked',
        priority === 'p1' && 'bg-status-in-progress/20 text-status-in-progress',
        priority === 'p2' && 'bg-well-700 text-ink',
        priority === 'p3' && 'bg-well-800 text-ink-dim',
      )}
    >
      {priority}
    </Badge>
  );
}

const SIZE_GLYPH: Record<Size, string> = { small: 's', medium: 'm', large: 'l' };

/** Size signal chip. */
export function SizeBadge({ size }: { size: Size }) {
  return <Badge variant="mono">{SIZE_GLYPH[size]}</Badge>;
}

/** The stale verdict marker — work sitting in flight too long. */
export function StaleBadge() {
  return (
    <Badge
      className="bg-status-in-progress/20 text-status-in-progress"
      title="stale — in flight too long"
    >
      ⧗ stale
    </Badge>
  );
}
