import type { ComponentProps, ReactNode, Ref } from 'react';

import { cn } from '../../lib/cn';
import { ActionButton } from '../ui/action-button';
import { BackGlyph } from './icons';

/*
 * Small pieces the walkthrough's screens share: the outcome word, the Back
 * button, the primary button, the quiet text button, and the headings that
 * take focus when a screen shows.
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

/** A screen's heading: it takes focus when the screen shows, and never a button. */
export function ScreenHeading({
  headingRef,
  className,
  children,
  ...props
}: ComponentProps<'h2'> & { headingRef: Ref<HTMLHeadingElement> }) {
  return (
    <h2
      ref={headingRef}
      tabIndex={-1}
      className={cn(
        'text-dossier font-bold wrap-anywhere text-ink-bright outline-none md:text-header',
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

/** The surface's one solid action. */
export function PrimaryButton({ className, ...props }: ComponentProps<typeof ActionButton>) {
  return (
    <ActionButton
      className={cn('min-h-12 md:col-start-3 md:min-h-11 md:min-w-[220px]', className)}
      {...props}
    />
  );
}

/** Back, an icon button; disabled on the first step. */
export function BackButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label="Back"
      className={cn(
        'inline-flex size-12 items-center justify-center rounded-lg text-ink inset-ring inset-ring-line-bright hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-35 md:size-11',
        className,
      )}
      {...props}
    >
      <BackGlyph />
    </button>
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

/** The bar at the bottom of a screen: a hairline above, the solid action in it. */
export function Composer({ children }: { children: ReactNode }) {
  return (
    <footer className="border-t border-line-bright bg-well-950 px-4 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-12 md:pt-3 md:pb-3.5">
      <div className="flex flex-col gap-2 md:max-w-[600px]">{children}</div>
    </footer>
  );
}

/** The scrolling body above a composer. */
export function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-4 pt-[18px] pb-6 md:px-12 md:py-[30px]">
      <div className="flex flex-col md:max-w-[600px]">{children}</div>
    </div>
  );
}

/** The small attention-violet line over a screen: its mark and kind. */
export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-faint">
      {children}
    </p>
  );
}
