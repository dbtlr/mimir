import {
  DialogBackdrop as SdkDialogBackdrop,
  DialogContent as SdkDialogContent,
  DialogDescription as SdkDialogDescription,
  DialogTitle as SdkDialogTitle,
} from '@ui-sdk/react/dialog';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';
import { mergeClassName } from './class-name';

/*
 * The Dialog primitive (ADR 0046): UI SDK's dialog behavior (focus trap,
 * Escape, outside press, focus return) in the Meridian look. A Dialog asks a
 * question and is centred at every width (ADR 0019, MMR-736); `size="full"`
 * covers the whole console for the Walkthrough. Patterns compose it; features
 * never import it directly.
 */

/*
 * Root, Trigger, and Close carry behavior only. Close is unstyled so a footer
 * renders it as the button it needs: `render={<ActionButton size="sm" />}`.
 */
export { Dialog, DialogClose, DialogTrigger } from '@ui-sdk/react/dialog';

/** The dimmed, lightly blurred page behind a modal Dialog or Alert Dialog. */
export const OVERLAY_BACKDROP_CLASS =
  'fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0';

/** The centred panel a Dialog or Alert Dialog opens. */
export const OVERLAY_PANEL_CLASS =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[min(88dvh,var(--visual-viewport-height,100dvh))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 text-ink shadow-2xl outline-none transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';

export function DialogBackdrop({ className, ...props }: ComponentProps<typeof SdkDialogBackdrop>) {
  return (
    <SdkDialogBackdrop className={mergeClassName(OVERLAY_BACKDROP_CLASS, className)} {...props} />
  );
}

const SIZE_CLASS = {
  default: 'w-[min(92vw,380px)]',
  full: 'inset-0 top-0 left-0 h-dvh max-h-none w-full translate-x-0 translate-y-0 rounded-none border-0',
  wide: 'w-[min(92vw,560px)]',
} as const;

export function DialogContent({
  className,
  size = 'default',
  ...props
}: ComponentProps<typeof SdkDialogContent> & { size?: keyof typeof SIZE_CLASS }) {
  return (
    <SdkDialogContent
      className={mergeClassName(OVERLAY_PANEL_CLASS, SIZE_CLASS[size], className)}
      data-size={size}
      {...props}
    />
  );
}

export const OVERLAY_TITLE_CLASS = 'text-sm font-semibold text-ink-bright';
export const OVERLAY_DESCRIPTION_CLASS = 'text-meta text-ink-dim';

export function DialogTitle({ className, ...props }: ComponentProps<typeof SdkDialogTitle>) {
  return <SdkDialogTitle className={mergeClassName(OVERLAY_TITLE_CLASS, className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof SdkDialogDescription>) {
  return (
    <SdkDialogDescription
      className={mergeClassName(OVERLAY_DESCRIPTION_CLASS, className)}
      {...props}
    />
  );
}

/** The row of answers at the foot of a Dialog or Alert Dialog, commit last. */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex justify-end gap-2 pt-1', className)} {...props} />;
}
