import { Dialog } from '@base-ui-components/react/dialog';
import { useState } from 'react';

import { ActionButton } from './ui/action-button';

/**
 * Required-reason modal for the seed triage verbs (MMR-247), adapted from the
 * node `ReasonDialog`: reject/resolve both demand a non-empty reason server-side
 * (400 otherwise), so confirm is disabled until the reason is non-empty. The
 * reason doubles as the triage record for the terminal decision.
 */
export function SeedReasonDialog({
  title,
  confirmLabel,
  open,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason('');
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-[60] flex w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none">
          <Dialog.Title className="text-sm font-semibold text-ink-bright">{title}</Dialog.Title>
          <textarea
            // autofocus lands in the reason box on open
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required) — the triage record"
            className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              disabled={trimmed === ''}
              onClick={() => {
                onConfirm(trimmed);
                setReason('');
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
