import { Dialog } from '@base-ui-components/react/dialog';
import { useEffect, useRef, useState } from 'react';

import { useCancelGroom } from '../api/agent-queries';
import type { GroomCancelResult } from '../api/fns/agent';
import { cancelAnswerText, formatTokens } from '../lib/agent-card';
import { ActionButton } from './ui/action-button';

/*
 * Stopping an agent run (ADR 0041's cancel refinement, MMR-635): the confirm
 * both the task page's card and the work page's Now row open. The dialog
 * opens on Keep running, the safe choice; Escape closes it and focus returns to
 * the control that opened it. A recorded cancel closes it. Any other answer
 * replaces the question with one sentence saying why nothing changed.
 */

/** The run a stop acts on, as it read when the operator opened the dialog. */
export type StopTarget = { runId: string; task: string; usedTokens: number };

const POPUP =
  'fixed top-1/2 left-1/2 z-[60] flex max-h-[90dvh] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none light:shadow-overlay';

type Refusal = Exclude<GroomCancelResult, { state: 'cancelling' }>;

/** The dialog's content: the question, or the answer that says why nothing changed. */
function StopRunContent({ target, onClose }: { target: StopTarget; onClose: () => void }) {
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const keepRunning = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stop = useCancelGroom((answer) => {
    if (answer.state === 'cancelling') {
      onClose();
    } else {
      setRefusal(answer);
    }
  });
  // The answer replaces the buttons, so focus moves to the one that is left.
  useEffect(() => {
    if (refusal !== undefined) {
      closeButton.current?.focus();
    }
  }, [refusal]);
  return (
    <Dialog.Popup className={POPUP} initialFocus={keepRunning}>
      <Dialog.Title className="text-sm font-semibold text-ink-bright">
        Stop the agent on {target.task}?
      </Dialog.Title>
      {refusal === undefined ? (
        <>
          <Dialog.Description className="flex flex-col gap-2 text-xs text-ink-dim">
            <span>
              It finishes the step it is on, then stops: usually seconds, at most 5 minutes.
            </span>
            <span>
              Notes it already wrote stay on the task. The {formatTokens(target.usedTokens)} tokens
              it has used so far count toward today&apos;s budget.
            </span>
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            <ActionButton ref={keepRunning} size="sm" variant="outline" onClick={onClose}>
              Keep running
            </ActionButton>
            <ActionButton
              size="sm"
              variant="destructiveOutline"
              disabled={stop.isPending}
              onClick={() => {
                stop.mutate({ runId: target.runId });
              }}
            >
              Stop run
            </ActionButton>
          </div>
        </>
      ) : (
        <>
          <Dialog.Description className="text-xs text-ink-dim">
            {cancelAnswerText(refusal)}
          </Dialog.Description>
          <div className="flex justify-end">
            <ActionButton ref={closeButton} size="sm" variant="outline" onClick={onClose}>
              Close
            </ActionButton>
          </div>
        </>
      )}
    </Dialog.Popup>
  );
}

/**
 * The stop confirm, for the run `target` names. The caller mounts it only
 * while it is open, as the grooming dialog's callers do: closing unmounts the
 * whole dialog, so no backdrop outlives it and each opening starts with the
 * question.
 */
export function StopRunDialog({ target, onClose }: { target: StopTarget; onClose: () => void }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-well-950/70 backdrop-blur-[2px]" />
        <StopRunContent target={target} onClose={onClose} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}
