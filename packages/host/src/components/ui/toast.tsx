import {
  Toast as SdkToast,
  ToastAction as SdkToastAction,
  ToastClose as SdkToastClose,
  ToastDescription as SdkToastDescription,
  ToastRegion as SdkToastRegion,
  ToastTitle as SdkToastTitle,
} from '@ui-sdk/react/toast';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { mergeClassName } from './class-name';

/*
 * The Toast primitive (ADR 0046): the Notice pattern's surface, replacing
 * Sonner. `toast(...)` works from anywhere; one `ToastStack` is mounted once
 * near the app root. It sits bottom-left on desktop and at the top below `md`,
 * clear of a sheet's footer. The toasts stack newest first
 * and fan out while the pointer or focus is in the region: upward from the
 * bottom edge, and downward from the top edge on a phone (`--stack`).
 *
 * It floats and is never mistaken for a card (DESIGN.md, Toast): a menu's
 * well-850 surface, an edge brighter than a card's `line` (ink-ghost in dark,
 * line-bright with the toast elevation in light), 14/20 ink text, and its
 * action an accent text button 44 tall on a phone and 36 from `md` up.
 */

/** The imperative API: `toast("Archived MMR-12", { action: { label: "Undo", onAction } })`. */
export { createToaster, toast } from '@ui-sdk/react/toast';

const REGION_CLASS =
  'fixed z-50 h-(--toast-front-height) w-[356px] max-w-[calc(100vw-2rem)] bottom-4 left-4 data-[expanded]:h-[calc(var(--toast-stack-height)+(var(--toast-count)-1)*12px)] max-md:top-4 max-md:right-3.5 max-md:bottom-auto max-md:left-3.5 max-md:w-auto max-md:max-w-none';

const TOAST_CLASS =
  'absolute inset-x-0 bottom-0 flex items-center gap-x-4 gap-y-1 overflow-hidden rounded-lg border border-ink-ghost bg-well-850 py-1 pr-1 pl-4 text-ink elevation-toast light:border-line-bright select-none outline-none [--stack:-1] max-md:[--stack:1] [--y:calc(var(--stack)*var(--toast-index)*12px)] z-[calc(100-var(--toast-index))] h-(--toast-height) translate-y-[calc(var(--y)+var(--toast-swipe-y,0px))] translate-x-(--toast-swipe-x,0px) scale-[calc(1-var(--toast-index)*0.05)] transition-[translate,scale,opacity,height] duration-300 [&:not([data-front],[data-expanded])]:h-(--toast-front-height) data-[expanded]:[--y:calc(var(--stack)*(var(--toast-offset)+var(--toast-index)*12px))] data-[expanded]:scale-100 data-[starting-style]:transition-none data-[starting-style]:data-[front]:[--y:calc(-1*var(--stack)*100%)] data-[starting-style]:not-data-[front]:opacity-0 data-[ending-style]:opacity-0 data-[swiping]:transition-none max-md:top-0 max-md:bottom-auto motion-reduce:transition-[opacity]';

/** A toast's action: an accent text button named for its effect ("Undo"). */
const TOAST_ACTION_CLASS =
  'inline-flex h-11 min-w-16 shrink-0 items-center justify-center rounded-md px-4 text-label font-semibold text-accent-foreground transition-colors empty:hidden hover:bg-line/50 focus-visible:outline-2 focus-visible:outline-accent md:h-9';

/** A toast's title, description, optional action and second button, with a close button. */
function ToastBody({
  cancel,
  wrapActions,
}: {
  cancel?: { label: ReactNode; onCancel?: ComponentProps<typeof SdkToastClose>['action'] };
  wrapActions: boolean;
}) {
  return (
    <SdkToast className={cn(TOAST_CLASS, wrapActions && 'max-sm:flex-wrap')}>
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-0.5 py-2.5',
          wrapActions && 'max-sm:flex-[0_0_100%] max-sm:wrap-anywhere',
        )}
      >
        <SdkToastTitle className="text-label text-ink [&_b]:font-semibold [&_b]:text-ink-bright" />
        <SdkToastDescription className="text-meta text-ink-dim" />
      </div>
      <SdkToastAction className={TOAST_ACTION_CLASS} />
      {cancel !== undefined && (
        <SdkToastClose action={cancel.onCancel} className={cn(TOAST_ACTION_CLASS, 'text-ink-bright')}>
          {cancel.label}
        </SdkToastClose>
      )}
      <SdkToastClose
        aria-label="Dismiss"
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent md:size-9',
          wrapActions && 'max-sm:ml-auto',
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </SdkToastClose>
    </SdkToast>
  );
}

/** The region that shows the queue; pass `toaster` to give it a queue of its own. */
export function ToastStack({
  className,
  side = 'bottom',
  align = 'start',
  ...props
}: Omit<ComponentProps<typeof SdkToastRegion>, 'children'>) {
  return (
    <SdkToastRegion
      side={side}
      align={align}
      className={mergeClassName(REGION_CLASS, className)}
      {...props}
    >
      {(item) => (
        <ToastBody
          cancel={item.cancel}
          wrapActions={item.action !== undefined && item.cancel !== undefined}
        />
      )}
    </SdkToastRegion>
  );
}
