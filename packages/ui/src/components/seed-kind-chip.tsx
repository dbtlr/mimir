import type { SeedKind } from '@mimir/contract';

import { cn } from '../lib/cn';
import { SEED_KIND_WASH } from '../lib/seed-kind';

/** The tinted kind pill (MMR-247) — wash + inset ring per kind, shared by every seed surface. */
export function SeedKindChip({ kind, className }: { kind: SeedKind; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-mono-id inset-ring',
        SEED_KIND_WASH[kind],
        className,
      )}
    >
      {kind}
    </span>
  );
}
