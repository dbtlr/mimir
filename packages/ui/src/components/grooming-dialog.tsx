import { Dialog } from '@base-ui-components/react/dialog';
import type { Grooming } from '@mimir/contract';
import { useState } from 'react';

import { useGroom } from '../api/mutations';
import { GROOMING_META, GROOMING_ORDER } from '../lib/grooming';
import { ActionButton } from './ui/action-button';

/**
 * The setter behind the task page's "Set grooming…" action (ADR 0033). Pick one
 * of the three states; "needs answers" also takes the open questions, which the
 * server writes as an ordinary note and requires. Any other state may carry a
 * note too. Offered for todo tasks only. The page mounts it only while open, so
 * each opening starts from the task's current state with an empty note.
 */
export function GroomingDialog({
  nodeId,
  current,
  open,
  onClose,
}: {
  nodeId: string;
  current: Grooming;
  open: boolean;
  onClose: () => void;
}) {
  const groom = useGroom(nodeId);
  const [chosen, setChosen] = useState<Grooming>(current);
  const [note, setNote] = useState('');
  const needsNote = chosen === 'needs_answers';
  const blank = note.trim() === '';

  function handleSet() {
    groom.mutate({ note, state: chosen }, { onSuccess: onClose });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90dvh] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none light:shadow-overlay">
          <Dialog.Title className="text-sm font-semibold text-ink-bright">
            Grooming state
          </Dialog.Title>
          <Dialog.Description className="text-xs text-ink-dim">
            Whether this task is understood well enough to run. It never blocks starting it.
          </Dialog.Description>
          <div role="radiogroup" aria-label="Grooming state" className="flex flex-col gap-1.5">
            {GROOMING_ORDER.map((state) => (
              <label
                aria-label={`${GROOMING_META[state].label}. ${GROOMING_META[state].hint}`}
                key={state}
                className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-xs text-ink inset-ring inset-ring-line has-[:checked]:bg-accent/10 has-[:checked]:inset-ring-accent/28 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
              >
                <input
                  type="radio"
                  name="grooming"
                  value={state}
                  checked={chosen === state}
                  onChange={() => setChosen(state)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span className="flex flex-col">
                  <span className="font-medium text-ink-bright">{GROOMING_META[state].label}</span>
                  <span className="text-ink-dim">{GROOMING_META[state].hint}</span>
                </span>
              </label>
            ))}
          </div>
          <textarea
            aria-label={needsNote ? 'Open questions (required)' : 'Note (optional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              needsNote
                ? 'Open questions (required) — what must be answered?'
                : 'Note (optional) — why this state'
            }
            className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close className="min-h-9 rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              disabled={(needsNote && blank) || groom.isPending}
              onClick={handleSet}
            >
              Set grooming
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
