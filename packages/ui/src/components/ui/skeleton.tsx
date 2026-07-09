import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/**
 * Vendored shadcn-style skeleton — a static placeholder card. No pulse: the mover
 * budget is spent (dot pulse, panel slide, note expand), so loading placeholders
 * hold still and read as absent content by tone alone. Skeletons stand in for
 * loading cards, so they take the placeholder-card idiom (`bg-well-850` +
 * `inset-ring inset-ring-line`) — a recessed well reads *raised* on the page
 * ground in dark, where well-recessed is lighter than the page.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded bg-well-850 inset-ring inset-ring-line', className)} {...props} />
  );
}
