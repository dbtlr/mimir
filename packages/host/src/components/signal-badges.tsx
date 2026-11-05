import type { Priority, Size } from '@mimir/contract';

import { Badge } from './ui/badge';

/**
 * Priority ink (ADR 0019 §1, MMR-626): priority is ordinal, so it steps down
 * the ink ramp instead of borrowing a status hue. p0 alone adds weight and the
 * bright hairline. p3 shares p2's ink because the ramp's faint step falls
 * below AA contrast on the chip ground; their labels tell them apart.
 */
const PRIORITY_INK: Record<Priority, string> = {
  p0: 'inset-ring-line-bright font-semibold text-ink-bright',
  p1: 'text-ink',
  p2: 'text-ink-dim',
  p3: 'text-ink-dim',
};

/** Priority signal chip — p0 brightest; a signal, never a sort (ADR 0007). */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge variant="mono" className={PRIORITY_INK[priority]}>
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

/**
 * The stale verdict marker — an open task nobody has touched in a while. Going
 * cold is a modifier in glyph plus demoted ink, never a status hue (ADR 0019
 * §3, MMR-620): it rides ready, queued, and blocked rows too, where an
 * in_progress hue would misread.
 */
export function StaleBadge() {
  return (
    <Badge className="text-ink-dim" title="stale — untouched in a while">
      ⧗ stale
    </Badge>
  );
}
