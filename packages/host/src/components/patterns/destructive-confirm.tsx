import { useRef } from 'react';
import type { ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { ConfirmCard } from '../ui/confirm-card';
import { useFinalFocus } from './opener';
import type { FinalFocus } from './opener';
import { useOpening } from './opening';

export type DestructiveConfirmProps = {
  open: boolean;
  /** Called when the operator backs out, or after `onConfirm`'s promise resolves. */
  onClose: () => void;
  title: string;
  /** What the action does and costs, in a sentence or two. */
  children: ReactNode;
  commitLabel: string;
  cancelLabel?: string;
  /**
   * Runs the action. Return a promise to have the dialog hold itself open while
   * it runs, close when it resolves, and stay open when it rejects. Return
   * nothing to close the dialog yourself, as a mutation's callback does. It
   * must not reopen this dialog before it returns.
   */
  onConfirm: () => void | Promise<void>;
  /** The call is in flight (for a caller that closes itself): the commit disables and Escape holds. */
  pending?: boolean;
  /** A line under the question, such as why a call failed; the question and both buttons stay. */
  notice?: ReactNode;
  /** The outcome that replaces the question and its buttons, leaving one Close. */
  answer?: ReactNode;
  /** Where focus goes on close, for an opener that is not a trigger the dialog knows. */
  finalFocus?: FinalFocus;
};

/**
 * Destructive confirm (ADR 0019, MMR-736): use it for an action that ends or
 * removes something and cannot be undone: stopping a run, unpairing or denying
 * a device, resetting the push key. Alert Dialog over `ConfirmCard`'s `bare`
 * body, centred at every width. It opens on Cancel, ignores outside presses,
 * and its commit wears the red hairline (MMR-635). An action that takes words
 * first is a Reason, not this.
 */
export function DestructiveConfirm({
  open,
  onClose,
  title,
  children,
  commitLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  pending = false,
  notice,
  answer,
  finalFocus,
}: DestructiveConfirmProps) {
  const returnTo = useFinalFocus(open, finalFocus);
  const { busy, commit } = useOpening(open, pending);
  const commitButton = useRef<HTMLButtonElement | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          return;
        }
        if (busy) {
          details.cancel();
        } else {
          onClose();
        }
      }}
    >
      <AlertDialogBackdrop />
      <AlertDialogContent finalFocus={returnTo}>
        <ConfirmCard
          surface="bare"
          title={title}
          titleAs={AlertDialogTitle}
          notice={notice}
          cancel={
            answer === undefined
              ? {
                  disabled: busy,
                  key: 'cancel',
                  label: cancelLabel,
                  onClick: onClose,
                }
              : {
                  autoFocus: true,
                  key: 'close',
                  label: 'Close',
                  onClick: onClose,
                }
          }
          confirm={
            answer === undefined
              ? {
                  disabled: busy,
                  label: commitLabel,
                  onClick: () =>
                    void commit(commitButton.current, onConfirm, (how) => {
                      if (how === 'resolved') {
                        onClose();
                      }
                    }),
                  ref: commitButton,
                  variant: 'destructiveOutline',
                }
              : undefined
          }
        >
          <AlertDialogDescription render={<div />}>
            {answer === undefined ? children : answer}
          </AlertDialogDescription>
        </ConfirmCard>
      </AlertDialogContent>
    </AlertDialog>
  );
}
