import type { ReactNode } from 'react';

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

/** Mount once near the app root: it shows every `toast`. */
export function NoticeHost({ offsetPastSidebar = false }: { offsetPastSidebar?: boolean }) {
  return <ToastStack className={offsetPastSidebar ? 'lg:left-[calc(16rem+24px)]' : undefined} />;
}
