import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/**
 * Feed cards in a stack 8px apart below `md`. From `md` up they are two
 * columns 12px apart only when two cards of 300 fit, a grid of 612, so the
 * columns follow the feed's own width beside an open preview rather than the
 * viewport's (ADR 0019, MMR-720 refinement). A `held` grid gives every row the
 * tallest row's height, for the Needs you deck's pages (MMR-721).
 */
export function CardGrid({ children, held = false }: { children: ReactNode; held?: boolean }) {
  return (
    <div className="@container">
      <div
        data-slot="card-grid"
        data-held={held ? '' : undefined}
        className={cn('grid gap-2 md:gap-3 md:@min-[612px]:grid-cols-2', held && 'auto-rows-fr')}
      >
        {children}
      </div>
    </div>
  );
}
