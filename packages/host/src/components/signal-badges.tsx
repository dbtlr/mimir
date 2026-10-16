import type { Priority, Size } from '@mimir/contract';

import { cn } from '../lib/cn';
import { Badge } from './ui/badge';

/** Priority signal chip — p0 burns hottest; a signal, never a sort (ADR 0007). */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge
      variant="mono"
      className={cn(
        priority === 'p0' &&
          'bg-status-blocked/12 inset-ring inset-ring-status-blocked/24 text-status-blocked-foreground',
        priority === 'p1' &&
          'bg-status-in-progress/12 inset-ring inset-ring-status-in-progress/24 text-status-in-progress-foreground',
        priority === 'p2' && 'bg-well-800 inset-ring inset-ring-line text-ink',
        priority === 'p3' && 'bg-well-800 inset-ring inset-ring-line text-ink-dim',
      )}
    >
      {priority}
    </Badge>
  );
}

const SIZE_GLYPH: Record<Size, string> = { large: 'l', medium: 'm', small: 's' };

/** Size signal chip. */
export function SizeBadge({ size }: { size: Size }) {
  return <Badge variant="mono">{SIZE_GLYPH[size]}</Badge>;
}

/**
 * The open-ended marker (MMR-204) — a container purposefully kept open for
 * filing (Bugs, Polish, Ideas): it never rolls up to done and drops out of its
 * parent's rollup when idle.
 */
export function OpenEndedBadge() {
  return (
    <Badge variant="mono" title="open-ended — a standing home, never rolls up to done">
      ∞ open-ended
    </Badge>
  );
}

/** The stale verdict marker — work sitting in flight too long. */
export function StaleBadge() {
  return (
    <Badge
      className="bg-status-in-progress/12 inset-ring inset-ring-status-in-progress/24 text-status-in-progress-foreground"
      title="stale — in flight too long"
    >
      ⧗ stale
    </Badge>
  );
}
