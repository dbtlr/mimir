import type { ReactNode } from 'react';

/**
 * Feed cards in a stack 8px apart below `md`. From `md` up they are two
 * columns 12px apart only when two cards of 300 fit, a grid of 612, so the
 * columns follow the feed's own width beside an open preview rather than the
 * viewport's (ADR 0019, MMR-720 refinement).
 */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <div data-slot="card-grid" className="grid gap-2 md:gap-3 md:@min-[612px]:grid-cols-2">
        {children}
      </div>
    </div>
  );
}
