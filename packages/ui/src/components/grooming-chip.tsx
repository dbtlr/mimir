import type { Grooming } from '@mimir/contract';

import type { WireNode } from '../api/types';
import { cn } from '../lib/cn';
import { GROOMING_META, visibleGrooming } from '../lib/grooming';
import { Badge } from './ui/badge';

/** Wash per state: needs answers calls for attention, groomed is settled, not groomed is quiet. */
const GROOMING_STYLE: Record<Grooming, string> = {
  groomed: 'bg-status-done/12 text-status-done-foreground inset-ring-status-done/24',
  needs_answers: 'bg-attention/12 text-attention-foreground inset-ring-attention/24',
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
