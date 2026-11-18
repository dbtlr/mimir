import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/**
 * The console's one icon-only control (MMR-715): a ghost square that takes the
 * 44px phone touch target (ADR 0019) and 36px from `md` up, holding an icon
 * from `./icons`. Base UI triggers and closes take it as a class:
 * `className={iconButtonClass}`.
 */
export const iconButtonClass =
  'relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 md:size-9 md:rounded-md';

/** A plain `<button>` in the icon-button shape. Name it with `aria-label`. */
export function IconButton({ className, type = 'button', ...props }: ComponentProps<'button'>) {
  return <button type={type} className={cn(iconButtonClass, className)} {...props} />;
}
