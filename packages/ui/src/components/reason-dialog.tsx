import { Dialog } from '@base-ui-components/react/dialog';
import { useState } from 'react';

import { cn } from '../lib/cn';
import type { VerbSpec } from '../lib/transitions';
import { ActionButton } from './ui/action-button';

/**
 * Reason-carrying confirmation modal, shared by the node lens and the seed
 * queue (MMR-247). Two shapes, selected by `required`:
 *  - optional (the node lens' park/block/abandon/return/reopen): confirm is
 *    always enabled — empty is a legitimate skip, the reason is genuine
 *    next-agent context.
 *  - required (the seed queue's reject/resolve): confirm stays disabled
 *    until the reason is non-empty — the reason doubles as the
 *    server-mandated triage record (400 otherwise).
 * `verb` drives the default (capitalized) title for the node lens; `title`
 * overrides it for callers with their own heading, like the seed dialogs.
 */
export function ReasonDialog({
  verb = null,
  title,
  confirmLabel = 'Confirm',
  required = false,
  open,
  onClose,
  onConfirm,
}: {
  verb?: VerbSpec['verb'] | null;
  title?: string;
  confirmLabel?: string;
  required?: boolean;
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
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none">
          <Dialog.Title
            className={cn(
              'text-sm font-semibold text-ink-bright',
              title === undefined && 'capitalize',
            )}
          >
            {title ?? verb}
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
            className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              disabled={required && trimmed === ''}
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
