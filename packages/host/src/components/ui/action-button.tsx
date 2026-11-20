import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The one-solid-button-per-surface primitive (radius 8). `action` is THE teal
 * fill (slate on light, where teal reads wrong); `attention` is the violet
 * fill for an ask only the operator can settle (approving a pairing request);
 * `attentionOutline` is its hairline sibling (a decision row's Answer…); `outline` is the quiet hairline
 * alternate; `destructiveOutline` is the hairline with a red ring and label for a
 * risky action (Unpair, Deny, Stop), since a status hue never fills a button (ADR 0019 §1). Solid fills carry `text-well-950`, which flips near-black in dark
 * and near-white in light so the label stays legible on either theme's fill.
 */
/**
 * The red hairline and label of a control that ends or removes something (ADR
 * 0019, MMR-635), on a neutral hover. A menu item that removes wears it too.
 */
export const DESTRUCTIVE_OUTLINE =
  'inset-ring inset-ring-status-blocked/35 text-status-blocked-foreground hover:bg-line/50';

/*
 * A disabled solid is a quiet button, not a faded one (DESIGN.md, Color roles):
 * well-800 with an ink-dim label (4.5:1 or better in both themes) and an inset
 * edge that keeps its shape on a well-850 footer, where the fill alone differs
 * by under 1.1:1. The other variants are hairlines already, so they fade.
 */
const QUIET_DISABLED =
  'disabled:bg-well-800 disabled:text-ink-dim disabled:inset-ring disabled:inset-ring-ink-ghost';

export const actionButtonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none',
  {
    compoundVariants: [
      { className: QUIET_DISABLED, variant: ['action', 'attention'] },
      {
        className: 'disabled:opacity-40',
        variant: ['attentionOutline', 'destructiveOutline', 'outline'],
      },
    ],
    defaultVariants: { size: 'default', variant: 'action' },
    variants: {
      // `sm` is the dialog-footer density that the form/dialog submit buttons
      // route through; `default` is the primary surface button (radius 8);
      // `form` is a Form sheet's footer button, 44 tall like the controls above it.
      size: {
        default: 'rounded-lg px-3 py-1.5 text-body',
        form: 'h-11 rounded-lg px-5 text-label',
        sm: 'rounded-md px-3 py-1.5 text-xs',
      },
      variant: {
        action: 'bg-action text-action-foreground hover:bg-action/90',
        attention: 'bg-attention-solid text-well-950 hover:bg-attention-solid/90',
        attentionOutline:
          'inset-ring inset-ring-attention/45 text-attention-foreground hover:bg-attention/10',
        destructiveOutline: DESTRUCTIVE_OUTLINE,
        outline:
          'inset-ring inset-ring-line-bright text-ink hover:bg-line/50 hover:text-ink-bright',
        /** A Form sheet's Cancel and Archive: an outline whose edge meets 3:1 (DESIGN.md). */
        formOutline:
          'inset-ring inset-ring-ink-faint text-ink-bright hover:inset-ring-ink-dim disabled:opacity-40',
      },
    },
  },
);

export type ActionButtonProps = ComponentProps<'button'> &
  VariantProps<typeof actionButtonVariants>;

export function ActionButton({ className, size, variant, type, ...props }: ActionButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(actionButtonVariants({ size, variant }), className)}
      {...props}
    />
  );
}
