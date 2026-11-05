import type { SeedKind } from '@mimir/contract';

import { cn } from '../lib/cn';

/**
 * The kind pill (MMR-247), shared by every seed surface. Kind is a category,
 * not a status, so every kind draws in the same neutral ink and the label
 * carries the meaning (ADR 0019 §1, MMR-626).
 */
export function SeedKindChip({ kind, className }: { kind: SeedKind; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-well-800 px-2 py-0.5 font-mono text-mono-id text-ink-dim inset-ring inset-ring-line',
        className,
      )}
    >
      {kind}
    </span>
  );
}
