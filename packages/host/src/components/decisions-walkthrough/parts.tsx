import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';

/*
 * Small pieces the walkthrough's screens share: the outcome word, the quiet
 * text button, and the meta line over a screen. The layer, its headings,
 * bars, answers, and commits are the Walkthrough pattern's.
 */

/** "Confirmed" in the `done` green, "Overturned" in the amber of work sent back. */
export function Outcome({ confirmed }: { confirmed: boolean }) {
  return (
    <span
      className={cn(
        'mr-1.5 font-semibold',
        confirmed ? 'text-status-done-foreground' : 'text-status-in-progress-foreground',
      )}
    >
      {confirmed ? 'Confirmed' : 'Overturned'}
    </span>
  );
}

/** A quiet text button, as the check step's Change. */
export function TextButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-sm text-meta font-semibold text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 max-md:min-h-11',
        className,
      )}
      {...props}
    />
  );
}

/** The small line over a screen: its mark and kind, in the meta voice. */
export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-dim">
      {children}
    </p>
  );
}
