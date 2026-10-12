import type { Grooming } from '@mimir/contract';

import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { GROOMING_META, visibleGrooming } from '../lib/grooming';
import { Badge } from './ui/badge';

/**
 * Violet is the needs-you set's alone (ADR 0019), and grooming is a pre-start
 * judgment, not something that needs the operator. Needs answers is an unresolved
 * concern, so it takes the amber record damage uses (see findings-chip.tsx).
 * Groomed is settled but not finished, so it stays neutral and brighter than
 * not groomed (with a check, which also tells them apart in greyscale); a green
 * chip on a ready card would read as done.
 */
const GROOMING_STYLE: Record<Grooming, string> = {
  groomed: 'text-ink inset-ring-line-bright',
  needs_answers:
    'bg-status-in-progress/10 text-status-in-progress-foreground inset-ring-status-in-progress/30',
  not_groomed: 'text-ink-dim inset-ring-line',
};

/** A grooming state as a chip. */
export function GroomingBadge({ state }: { state: Grooming }) {
  return (
    <Badge
      variant="outline"
      // font-sans: a Details row sits in a monospace value cell, but the chip reads the same everywhere.
      className={cn('font-sans', GROOMING_STYLE[state])}
      title={GROOMING_META[state].hint}
    >
      {state === 'groomed' && <span aria-hidden>✓</span>}
      {GROOMING_META[state].label}
    </Badge>
  );
}

/**
 * The grooming chip for a node, or nothing when the node shows none (a started,
 * finished, or container node, or a server that sends no state).
 */
export function GroomingChip({ node }: { node: WireNode }) {
  const state = visibleGrooming(node);
  return state === undefined ? null : <GroomingBadge state={state} />;
}
