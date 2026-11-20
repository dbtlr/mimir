import {
  Toast as SdkToast,
  ToastAction as SdkToastAction,
  ToastClose as SdkToastClose,
  ToastDescription as SdkToastDescription,
  ToastRegion as SdkToastRegion,
  ToastTitle as SdkToastTitle,
} from '@ui-sdk/react/toast';
import type { ComponentProps, ReactNode } from 'react';

import { ActionButton } from './action-button';
import { mergeClassName } from './class-name';

/*
 * The Toast primitive (ADR 0046): the Notice pattern's surface, replacing
 * Sonner. `toast(...)` works from anywhere; one `ToastStack` is mounted once
 * near the app root (MMR-740 does the swap). Placement matches Sonner today:
 * bottom-left on desktop, top-centre below `sm`. The toasts stack newest first
 * and fan out while the pointer or focus is in the region: upward from the
 * bottom edge, and downward from the top edge on a phone (`--stack`).
 */

/** The imperative API: `toast("Archived MMR-12", { action: { label: "Undo", onAction } })`. */
export { createToaster, toast } from '@ui-sdk/react/toast';

const REGION_CLASS =
  'fixed z-50 h-(--toast-front-height) w-[356px] max-w-[calc(100vw-2rem)] bottom-4 left-4 data-[expanded]:h-[calc(var(--toast-stack-height)+(var(--toast-count)-1)*12px)] max-sm:top-4 max-sm:bottom-auto max-sm:left-1/2 max-sm:-translate-x-1/2';

const TOAST_CLASS =
  'absolute inset-x-0 bottom-0 flex items-start gap-3 overflow-hidden rounded-lg border border-line-bright bg-well-900 p-3 text-ink shadow-2xl select-none outline-none [--stack:-1] max-sm:[--stack:1] [--y:calc(var(--stack)*var(--toast-index)*12px)] z-[calc(100-var(--toast-index))] h-(--toast-height) translate-y-[calc(var(--y)+var(--toast-swipe-y,0px))] translate-x-(--toast-swipe-x,0px) scale-[calc(1-var(--toast-index)*0.05)] transition-[translate,scale,opacity,height] duration-300 [&:not([data-front],[data-expanded])]:h-(--toast-front-height) data-[expanded]:[--y:calc(var(--stack)*(var(--toast-offset)+var(--toast-index)*12px))] data-[expanded]:scale-100 data-[starting-style]:transition-none data-[starting-style]:data-[front]:[--y:calc(-1*var(--stack)*100%)] data-[starting-style]:not-data-[front]:opacity-0 data-[ending-style]:opacity-0 data-[swiping]:transition-none max-sm:top-0 max-sm:bottom-auto motion-reduce:transition-[opacity]';

/** A toast's title, description, optional action and second button, with a close button. */
function ToastBody({
  cancel,
}: {
  cancel?: { label: ReactNode; onCancel?: ComponentProps<typeof SdkToastClose>['action'] };
}) {
  return (
    <SdkToast className={TOAST_CLASS}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SdkToastTitle className="text-sm font-semibold text-ink-bright" />
        <SdkToastDescription className="text-meta text-ink-dim" />
      </div>
      <SdkToastAction
        render={<ActionButton size="sm" variant="outline" />}
        className="shrink-0 empty:hidden"
      />
      {cancel !== undefined && (
        <SdkToastClose
          aria-label={typeof cancel.label === 'string' ? cancel.label : undefined}
          render={<ActionButton size="sm" variant="outline" />}
          action={cancel.onCancel}
          className="shrink-0"
        >
          {cancel.label}
        </SdkToastClose>
      )}
      <SdkToastClose
        aria-label="Dismiss"
        className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-line/50 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
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
      {(item) => <ToastBody cancel={item.cancel} />}
    </SdkToastRegion>
  );
}
