import { Dialog } from '@base-ui-components/react/dialog';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';

import { transitionLabel } from '../lib/transitions';
import type { VerbSpec } from '../lib/transitions';
import type { ActionButtonProps } from './ui/action-button';
import { ActionButton } from './ui/action-button';

/** Dialog chrome shared with the decision answer dialog, so the console's modals match. */
export const DIALOG_TITLE_CLASS = 'text-sm font-semibold text-ink-bright';
export const DIALOG_FIELD_CLASS =
  'min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent';
export const DIALOG_CANCEL_CLASS = 'rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink';

/**
 * Reason-carrying confirmation modal, shared by the node lens and the seed
 * queue (MMR-247). Two shapes, selected by `required`:
 *  - optional (the node lens' park/block/abandon/return/reopen): confirm is
 *    always enabled — empty is a legitimate skip, the reason is genuine
 *    next-agent context.
 *  - required (the seed queue's reject/resolve): confirm stays disabled
 *    until the reason is non-empty — the reason doubles as the
 *    server-mandated triage record (400 otherwise).
 * `verb` drives the default title (the action's plain label) for the node lens; `title`
 * overrides it for callers with their own heading, like the seed dialogs.
 * `keepOpenOnRefusal` opts into awaiting onConfirm and retaining text on rejection.
 * `confirmVariant` opts into a different commit outline; existing callers keep their style.
 * `disabled` locks closing and the commit together. `closeLocked` opts into locking closing
 * (Cancel, Escape, backdrop) separately, so a caller can keep the commit disabled
 * (offline) while the operator can still back out.
 * `finalFocus` names the element that takes focus when the dialog closes, for
 * an opener that is not a dialog trigger, which Base UI cannot find by itself.
 */
export function ReasonDialog({
  verb = null,
  title,
  confirmLabel = 'Confirm',
  required = false,
  keepOpenOnRefusal = false,
  confirmVariant,
  disabled = false,
  closeLocked = disabled,
  finalFocus,
  open,
  onClose,
  onConfirm,
}: {
  verb?: VerbSpec['verb'] | null;
  title?: string;
  confirmLabel?: string;
  required?: boolean;
  keepOpenOnRefusal?: boolean;
  confirmVariant?: ActionButtonProps['variant'];
  disabled?: boolean;
  closeLocked?: boolean;
  finalFocus?: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  // Set before the awaited write, so a second click lands on a closed gate, not a stale button.
  const committing = useRef(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeLocked) {
          setReason('');
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup
          finalFocus={finalFocus}
          className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none"
        >
          <Dialog.Title className={DIALOG_TITLE_CLASS}>
            {title ?? (verb === null ? '' : transitionLabel(verb))}
          </Dialog.Title>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            placeholder={
              required
                ? 'Reason (required) — the triage record'
                : 'Reason (optional) — context for the next agent'
            }
            className={DIALOG_FIELD_CLASS}
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close disabled={closeLocked} className={DIALOG_CANCEL_CLASS}>
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              variant={confirmVariant}
              disabled={disabled || (required && trimmed === '')}
              onClick={async () => {
                if (keepOpenOnRefusal) {
                  if (committing.current) {
                    return;
                  }
                  committing.current = true;
                  try {
                    await onConfirm(trimmed);
                    setReason('');
                    onClose();
                  } catch {
                    // The mutation toasts the refusal; retain the reason for another attempt.
                  } finally {
                    committing.current = false;
                  }
                } else {
                  void onConfirm(trimmed);
                  setReason('');
                }
              }}
            >
              {confirmLabel}
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
