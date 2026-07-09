import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/*
 * The one-solid-button-per-surface primitive (radius 8). `action` is THE teal
 * fill (slate on light, where teal reads wrong); `attention` is the violet
 * Approve verdict; `outline` is the quiet hairline alternate. Solid fills carry
 * `text-well-950`, which flips near-black in dark and near-white in light so the
 * label stays legible on either theme's fill.
 */
const actionButtonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-body font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
  {
    defaultVariants: { variant: 'action' },
    variants: {
      variant: {
        action: 'bg-action text-action-foreground hover:bg-action/90',
        attention: 'bg-attention-solid text-well-950 hover:bg-attention-solid/90',
        outline:
          'inset-ring inset-ring-line-bright text-ink hover:bg-line/50 hover:text-ink-bright',
      },
    },
  },
);

export type ActionButtonProps = {} & ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof actionButtonVariants>;

export function ActionButton({ className, variant, type, ...props }: ActionButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(actionButtonVariants({ variant }), className)}
      {...props}
    />
  );
}
