import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/*
 * Vendored shadcn-style card — a flat hairline panel over the well (radius 10).
 * Elevation is tone + line, not shadow, in dark; light gets a single faint lift.
 * `recessed` demotes done / folded content to the recessed well with ghost ink.
 * A status left-border is applied by consumers via the literal `border-l-2` +
 * `STATUS_META[...].border` classes, keeping Tailwind extraction literal.
 */
export const cardVariants = cva('rounded-[10px] border border-line bg-well-850 light:shadow-card', {
  defaultVariants: { variant: 'default' },
  variants: {
    variant: {
      default: '',
      recessed: 'bg-well-recessed text-ink-ghost light:shadow-none',
    },
  },
});

export type CardProps = {} & HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>;

export function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-3', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-3 pt-0', className)} {...props} />;
}
