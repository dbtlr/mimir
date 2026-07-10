import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/** Vendored shadcn-style badge — chip-dense, mono-friendly (console flavor). */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-tag font-medium whitespace-nowrap md:text-micro',
  {
    defaultVariants: { variant: 'default' },
    variants: {
      variant: {
        default: 'bg-well-800 inset-ring inset-ring-line text-ink',
        mono: 'bg-well-800 inset-ring inset-ring-line font-mono text-tag text-ink-dim md:text-micro',
        outline: 'inset-ring inset-ring-line-bright text-ink',
      },
    },
  },
);

export type BadgeProps = {} & HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/*
 * The status chip — the wash idiom made literal, and the single documentation
 * point for it. Canonical wash ratio: `/12` hue fill under a 1px inset ring at
 * `/24` (~2x the fill alpha), with the hue's `-foreground` text tone.
 * segmented-control.tsx mirrors this ratio for the active segment. Nine literal
 * variants keyed by the status vocabulary so Tailwind extracts every class; the
 * ring rides in both themes (a light-mode legibility rule).
 */
export const statusChipVariants = cva(
  'inline-flex items-center gap-1.5 font-semibold whitespace-nowrap',
  {
    defaultVariants: { shape: 'chip', status: 'new' },
    variants: {
      // `chip` is the board-card idiom (rounded-sm, mixed-case, no tracking);
      // `pill` is the header idiom (rounded-full, uppercase, tracked) the
      // dossier header, project header, and overview attention pill share.
      shape: {
        chip: 'rounded-sm px-1.5 py-0.5 text-tag',
        pill: 'rounded-full px-2.5 py-1 text-micro tracking-[0.06em] uppercase',
      },
      status: {
        abandoned:
          'bg-status-abandoned/12 text-status-abandoned-foreground inset-ring inset-ring-status-abandoned/24',
        awaiting:
          'bg-status-awaiting/12 text-status-awaiting-foreground inset-ring inset-ring-status-awaiting/24',
        blocked:
          'bg-status-blocked/12 text-status-blocked-foreground inset-ring inset-ring-status-blocked/24',
        done: 'bg-status-done/12 text-status-done-foreground inset-ring inset-ring-status-done/24',
        in_progress:
          'bg-status-in-progress/12 text-status-in-progress-foreground inset-ring inset-ring-status-in-progress/24',
        new: 'bg-status-new/12 text-status-new-foreground inset-ring inset-ring-status-new/24',
        parked:
          'bg-status-parked/12 text-status-parked-foreground inset-ring inset-ring-status-parked/24',
        ready:
          'bg-status-ready/12 text-status-ready-foreground inset-ring inset-ring-status-ready/24',
        under_review:
          'bg-status-under-review/12 text-status-under-review-foreground inset-ring inset-ring-status-under-review/24',
      },
    },
  },
);
