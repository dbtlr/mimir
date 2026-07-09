import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/**
 * Vendored shadcn-style skeleton — a static recessed block. No pulse: the mover
 * budget is spent (dot pulse, panel slide, note expand), so loading placeholders
 * hold still and read as absent content by tone alone.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded bg-well-recessed', className)} {...props} />;
}
