import { Dialog } from '@base-ui-components/react/dialog';
import type { Grooming } from '@mimir/contract';
import { useEffect, useState } from 'react';

import { useGroom } from '../api/mutations';
import { GROOMING_META, GROOMING_ORDER } from '../lib/grooming';
import { ActionButton } from './ui/action-button';

/**
 * Setting a task's grooming state from the task page: the dialog opens on the
 * task's current state.
 */
type SetMode = { mode?: 'set'; current: Grooming };

/**
 * Answering a needs-answers task from the work page: the operator's answer is
 * required and becomes the note, and no state is chosen for them.
 */
type AnswerMode = { mode: 'answer'; question: string | null };

/**
 * The note field's label and placeholder. An answer that keeps the task at
 * needs answers becomes its latest question, so it asks for what is still open.
 */
function noteCopy(
  answering: boolean,
  chosen: Grooming | null,
): { label: string; placeholder: string } {
  if (answering && chosen === 'needs_answers') {
    return {
      label: 'Answer, and what is still open (required)',
      placeholder: 'Answer, then the questions still open — shown as the latest question',
    };
  }
  if (answering) {
    return {
      label: 'Answer (required)',
      placeholder: 'Answer (required) — saved as a note on the task',
    };
  }
  if (chosen === 'needs_answers') {
    return {
      label: 'Open questions (required)',
      placeholder: 'Open questions (required) — what must be answered?',
    };
  }
  return { label: 'Note (optional)', placeholder: 'Note (optional) — why this state' };
}

/**
 * The setter behind the task page's "Set grooming…" action and the work page's
 * Answer… (ADR 0033). Pick one of the three states; "needs answers" also takes
 * the open questions, which the server writes as an ordinary note and requires.
 * Any other state may carry a note too, and an answer always does. Offered for
 * todo tasks only. Callers mount it only while open, so each opening starts
 * fresh with an empty note.
 */
export function GroomingDialog({
  nodeId,
  open,
  onClose,
  ...mode
}: {
  nodeId: string;
  open: boolean;
  onClose: () => void;
} & (SetMode | AnswerMode)) {
  const groom = useGroom(nodeId);
  const answering = mode.mode === 'answer';
  const [chosen, setChosen] = useState<Grooming | null>(answering ? null : mode.current);
  const [note, setNote] = useState('');
  const blank = note.trim() === '';
  const needsNote = answering || chosen === 'needs_answers';

  // Close once the success renders. A mutate callback would run before the
  // refetched records render, and the work page needs a row the answer moves
  // to leave before its dialog closes (MMR-474).
  useEffect(() => {
    if (groom.isSuccess) {
      onClose();
    }
  }, [groom.isSuccess, onClose]);

  function handleSet() {
    if (chosen !== null) {
      groom.mutate({ note, state: chosen });
    }
  }

  const copy = noteCopy(answering, chosen);

  // An answer comes before the state it settles; a state comes before its note.
  const noteField = (
    <textarea
      aria-label={copy.label}
      value={note}
      onChange={(e) => setNote(e.target.value)}
      placeholder={copy.placeholder}
      className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
    />
  );

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
            {answering ? 'Answer' : 'Grooming state'}
          </Dialog.Title>
          {answering && mode.question !== null && (
            <blockquote className="rounded-sm border-l-2 border-attention bg-well-850 px-2.5 py-1.5 text-xs whitespace-pre-line text-attention-foreground">
              {mode.question}
            </blockquote>
          )}
          <Dialog.Description className="text-xs text-ink-dim">
            {answering
              ? 'Your answer is saved as a note. Then say whether the task is understood well enough to run.'
              : 'Whether this task is understood well enough to run. It never blocks starting it.'}
          </Dialog.Description>
          {answering && noteField}
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
          {!answering && noteField}
          <div className="flex justify-end gap-2">
            <Dialog.Close className="min-h-9 rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              disabled={chosen === null || (needsNote && blank) || groom.isPending}
              onClick={handleSet}
            >
              {answering ? 'Answer' : 'Set grooming'}
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
