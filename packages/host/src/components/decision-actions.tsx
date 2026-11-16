import { Dialog } from '@base-ui-components/react/dialog';
import type { EngineDecision } from '@mimir/contract';
import { useEffect, useRef, useState } from 'react';

import { useConfirm, useOverturn } from '../api/delivery-mutations';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { useDisarmWhenSettled } from '../lib/use-row-focus-handoff';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { DIALOG_CANCEL_CLASS, DIALOG_FIELD_CLASS, DIALOG_TITLE_CLASS } from './reason-dialog';
import { ActionButton } from './ui/action-button';

/** Terminal answers stay outside data-row-actions: handoff must never commit another answer. */
export function DecisionActions({
  decision,
  offline,
  handoff,
}: {
  decision: Omit<EngineDecision, 'history'>;
  offline: boolean;
  handoff: RowFocusHandoff;
}) {
  const confirm = useConfirm();
  const overturn = useOverturn();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  // Set before `mutate`, since the buttons only disable after TanStack re-renders.
  const inFlight = useRef(false);
  const [refusal, setRefusal] = useState<{ chip: HTMLButtonElement } | null>(null);
  const refocused = useRef(refusal);
  const pending = confirm.isPending || overturn.isPending;
  const disabled = offline || pending;
  // Successful answers are terminal; keep the handoff armed until the refreshed row leaves.
  useDisarmWhenSettled(
    handoff,
    decision.id,
    pending || open || confirm.isSuccess || overturn.isSuccess
      ? null
      : Math.max(confirm.submittedAt, overturn.submittedAt),
  );
  // A refused chip takes focus back once it is enabled again: the write settled, and the console
  // is online. A refusal that lands offline waits for the connection, not just the settle.
  useEffect(() => {
    if (refusal !== refocused.current && !disabled) {
      refocused.current = refusal;
      refusal?.chip.focus();
    }
  }, [refusal, disabled]);
  function answer(
    input: { option?: number; note?: string },
    confirming: boolean,
    chip?: HTMLButtonElement,
  ) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    handoff.arm(decision.id);
    const callbacks = {
      onError: () => {
        if (chip) {
          setRefusal({ chip });
        }
      },
      onSettled: () => {
        inFlight.current = false;
      },
      onSuccess: () => {
        setOpen(false);
        setNote('');
      },
    };
    if (confirming) {
      confirm.mutate(
        { id: decision.id, ...(input.note === undefined ? {} : { note: input.note }) },
        callbacks,
      );
    } else {
      overturn.mutate({ id: decision.id, ...input }, callbacks);
    }
  }
  return (
    <>
      <div role="group" aria-label={`Answers for ${decision.id}`} className="flex flex-wrap gap-2">
        {decision.options.map((option, index) => {
          const number = index + 1;
          const taken = number === decision.taken;
          return (
            <ActionButton
              key={number}
              size="sm"
              variant="attentionOutline"
              className={PHONE_TOUCH_TARGET}
              disabled={disabled}
              aria-label={`${taken ? 'Confirm' : 'Take'} option ${number} for ${decision.id}: ${option}`}
              onClick={(event) =>
                answer(taken ? {} : { option: number }, taken, event.currentTarget)
              }
            >
              {taken ? 'Confirm' : 'Take'} {number}
            </ActionButton>
          );
        })}
        <ActionButton
          ref={opener}
          size="sm"
          variant="attentionOutline"
          className={PHONE_TOUCH_TARGET}
          disabled={disabled}
          aria-label={`Note for ${decision.id}: ${decision.question}`}
          onClick={() => setOpen(true)}
        >
          Note…
        </ActionButton>
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            setOpen(next);
            if (!next) {
              setNote('');
            }
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
          <Dialog.Popup
            finalFocus={opener}
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none"
          >
            <Dialog.Title className={DIALOG_TITLE_CLASS}>Answer {decision.id}</Dialog.Title>
            <Dialog.Description className="text-xs wrap-anywhere text-ink-dim">
              {decision.question}
            </Dialog.Description>
            <textarea
              aria-label="Note (required)"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={DIALOG_FIELD_CLASS}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close disabled={pending} className={DIALOG_CANCEL_CLASS}>
                Cancel
              </Dialog.Close>
              <ActionButton
                size="sm"
                variant="outline"
                disabled={disabled || !note.trim()}
                onClick={(event) => answer({ note: note.trim() }, true, event.currentTarget)}
              >
                Confirm with note
              </ActionButton>
              <ActionButton
                size="sm"
                variant="outline"
                disabled={disabled || !note.trim()}
                onClick={(event) => answer({ note: note.trim() }, false, event.currentTarget)}
              >
                Answer with note
              </ActionButton>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
