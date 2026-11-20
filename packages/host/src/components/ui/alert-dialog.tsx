import {
  AlertDialogBackdrop as SdkAlertDialogBackdrop,
  AlertDialogContent as SdkAlertDialogContent,
  AlertDialogDescription as SdkAlertDialogDescription,
  AlertDialogTitle as SdkAlertDialogTitle,
} from '@ui-sdk/react/alert-dialog';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';
import {
  OVERLAY_BACKDROP_CLASS,
  OVERLAY_DESCRIPTION_CLASS,
  OVERLAY_PANEL_CLASS,
  OVERLAY_TITLE_CLASS,
} from './dialog';

/*
 * The Alert Dialog primitive (ADR 0046): the surface of the Destructive
 * confirm pattern (ADR 0019, MMR-635). Unlike a Dialog it ignores outside
 * presses, so the answer is always an explicit button; the panel, title, and
 * footer share the Dialog look. The footer is `DialogFooter` from ./dialog:
 * Cancel as an outline ActionButton, the commit last as
 * `variant="destructiveOutline"`.
 */

/** Root, Trigger, and Close carry behavior only; render Close as an ActionButton. */
export { AlertDialog, AlertDialogClose, AlertDialogTrigger } from '@ui-sdk/react/alert-dialog';

export function AlertDialogBackdrop({
  className,
  ...props
}: ComponentProps<typeof SdkAlertDialogBackdrop>) {
  return (
    <SdkAlertDialogBackdrop
      className={mergeClassName(OVERLAY_BACKDROP_CLASS, className)}
      {...props}
    />
  );
}

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof SdkAlertDialogContent>) {
  return (
    <SdkAlertDialogContent
      className={mergeClassName(OVERLAY_PANEL_CLASS, 'w-[min(92vw,380px)]', className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof SdkAlertDialogTitle>) {
  return (
    <SdkAlertDialogTitle className={mergeClassName(OVERLAY_TITLE_CLASS, className)} {...props} />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof SdkAlertDialogDescription>) {
  return (
    <SdkAlertDialogDescription
      className={mergeClassName(OVERLAY_DESCRIPTION_CLASS, className)}
      {...props}
    />
  );
}
