import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { toast as sdkToast, ToastStack } from '../ui/toast';

/*
 * Notice, the toast half (ADR 0019, MMR-736): use it for an outcome whose ask
 * has already closed ("Archived Mimir", "Couldn't save"), optionally with Undo
 * or Retry. A standing state is the banner (`NoticeBanner`), not a toast.
 *
 * The call shape is Sonner's, so moving a call site changes its import and
 * nothing else: `toast.success(text)`, `toast.error(text, { action: { label:
 * 'Retry', onClick } })`. The action runs once and dismisses the toast; an
 * `onClick` that returns a promise keeps the toast, pending, until it settles.
 * An error toast is announced at once, and the others wait for a pause.
 */

export type NoticeAction = { label: string; onClick: () => unknown };

export type NoticeOptions = {
  /** Undo or Retry. */
  action?: NoticeAction;
  /** A second button that dismisses the toast after it runs, such as Open thread. */
  cancel?: NoticeAction;
  /** A second line under the message. */
  description?: ReactNode;
  /** Milliseconds on screen; the default is five seconds. */
  duration?: number;
};

type Kind = 'success' | 'error' | 'info' | 'warning';

function sdkOptions(options: NoticeOptions | undefined) {
  if (options === undefined) {
    return {};
  }
  const { action, cancel, description, duration } = options;
  return {
    ...(action === undefined
      ? {}
      : { action: { label: action.label, onAction: () => action.onClick() } }),
    ...(cancel === undefined
      ? {}
      : { cancel: { label: cancel.label, onCancel: () => void cancel.onClick() } }),
    ...(description === undefined ? {} : { description }),
    ...(duration === undefined ? {} : { duration }),
  };
}

function show(kind: Kind | undefined, message: ReactNode, options?: NoticeOptions): string {
  const given = sdkOptions(options);
  return kind === undefined ? sdkToast(message, given) : sdkToast[kind](message, given);
}

/** Show a Notice. `toast.dismiss()` closes every one, or one by the id it returned. */
export const toast = Object.assign(
  (message: ReactNode, options?: NoticeOptions) => show(undefined, message, options),
  {
    dismiss: (id?: string) => {
      sdkToast.dismiss(id);
    },
    error: (message: ReactNode, options?: NoticeOptions) => show('error', message, options),
    info: (message: ReactNode, options?: NoticeOptions) => show('info', message, options),
    success: (message: ReactNode, options?: NoticeOptions) => show('success', message, options),
    warning: (message: ReactNode, options?: NoticeOptions) => show('warning', message, options),
  },
);

/**
 * Mount once near the app root: it shows every `toast`. On a desktop they sit
 * bottom-left on the content column's 20px gutter, past the sidebar when it
 * shows, and 20 above the content area's bottom, past the version footer whose
 * height an ancestor sets as `--version-footer-height`; on a phone, at the top (a bottom sheet's footer owns the bottom), 8
 * below the top bar whose height an ancestor sets as `--top-bar-height`, on the
 * phone page's 14px gutter. While a Walkthrough covers the console, it sits 8
 * below the layer's header instead, from `--layer-top-bar-height`, which the
 * layer sets on the root while it is open. A Notice floats over what is under it, the first
 * card or a route's banner, and the page does not move for it (DESIGN.md, Toast).
 * While a desktop preview panel is open (`clearOfPanel`), a toast narrows to
 * end 20 short of the panel's 440, so the panel never covers it.
 */
export function NoticeHost({
  offsetPastSidebar = false,
  clearOfPanel = false,
}: {
  offsetPastSidebar?: boolean;
  clearOfPanel?: boolean;
}) {
  return (
    <ToastStack
      className={cn(
        'max-md:top-[calc(var(--layer-top-bar-height,var(--top-bar-height,0px))+0.5rem)] md:bottom-[calc(var(--version-footer-height,0px)+1.25rem)] md:left-5',
        offsetPastSidebar && 'lg:left-[calc(16rem+20px)]',
        clearOfPanel &&
          (offsetPastSidebar
            ? 'md:max-w-[calc(100vw-16rem-480px)]'
            : 'md:max-w-[calc(100vw-480px)]'),
      )}
    />
  );
}
