import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/** Vendored shadcn-style skeleton — loading shimmer on the panel tone. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded bg-well-700/60', className)} {...props} />;
}
