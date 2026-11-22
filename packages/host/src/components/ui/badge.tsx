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
