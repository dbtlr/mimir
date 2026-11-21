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

/**
 * A quiet text button, as the check step's Change. Its 23px line sits on the
 * first line of the prose beside it; on a phone a pseudo-element stretches its
 * tap area to 44 tall without moving the text off that line.
 */
export function TextButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'relative rounded-sm text-meta leading-[23px] font-semibold text-accent-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 max-md:after:absolute max-md:after:-inset-x-2 max-md:after:-inset-y-[10.5px]',
        className,
      )}
      {...props}
    />
  );
}

/** The small line over a decision's step: the agent's mark, the kind, age, and id, in the meta voice. */
export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta leading-5 text-ink-dim">
      {children}
    </p>
  );
}
