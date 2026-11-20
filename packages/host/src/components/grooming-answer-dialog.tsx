import type { Grooming } from '@mimir/contract';
import { useEffect, useState } from 'react';

import { useGroom } from '../api/node-mutations';
import { GROOMING_META, GROOMING_ORDER } from '../lib/grooming';
import { Reason } from './patterns/reason';

/**
 * The note field's label and placeholder. An answer that keeps the task at
 * needs answers becomes its latest question, so it asks for what is still open.
 */
function noteCopy(chosen: Grooming | null): { label: string; placeholder: string } {
  if (chosen === 'needs_answers') {
    return {
      label: 'Answer, and what is still open (required)',
      placeholder: 'Answer, then the questions still open — shown as the latest question',
    };
  }
  return {
    label: 'Answer (required)',
    placeholder: 'Answer (required) — saved as a note on the task',
  };
}

/**
 * Answering a needs-answers task from the work page (ADR 0033), a Reason
 * dialog (ADR 0019, MMR-736): the operator's answer is required and becomes
 * the note, then they say whether the task is understood well enough to run.
 * No state is chosen for them. Callers mount it only while open, so each
 * opening starts fresh.
 */
export function GroomingAnswerDialog({
  nodeId,
  question,
  onClose,
}: {
  nodeId: string;
  question: string | null;
  onClose: () => void;
}) {
  const groom = useGroom(nodeId);
  const [chosen, setChosen] = useState<Grooming | null>(null);

  // Close once the success renders. A mutate callback would run before the
  // refetched records render, and the work page needs a row the answer moves
  // to leave before its dialog closes (MMR-474).
  useEffect(() => {
    if (groom.isSuccess) {
      onClose();
    }
  }, [groom.isSuccess, onClose]);

  const copy = noteCopy(chosen);
  return (
    <Reason
      open
      required
      closeOnCommit={false}
      pending={groom.isPending}
      onClose={onClose}
      title="Answer"
      label={copy.label}
      placeholder={copy.placeholder}
      lead={
        question === null ? undefined : (
          <blockquote className="rounded-sm border-l-2 border-attention bg-well-850 px-2.5 py-1.5 text-xs whitespace-pre-line text-attention-foreground">
            {question}
          </blockquote>
        )
      }
      description="Your answer is saved as a note. Then say whether the task is understood well enough to run."
      commitDisabled={chosen === null}
      commits={[
        {
          label: 'Answer',
          onCommit: (note) => {
            if (chosen !== null) {
              groom.mutate({ note, state: chosen });
            }
          },
        },
      ]}
    >
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
    </Reason>
  );
}
