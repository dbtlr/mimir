import type { EngineDecision } from '@mimir/contract';
import { useEffect, useRef, useState } from 'react';

import { useConfirm, useOverturn } from '../api/delivery-mutations';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { useDisarmWhenSettled } from '../lib/use-row-focus-handoff';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { Reason } from './patterns/reason';
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
  /**
   * Send an answer. The promise settles with the call, so a dialog commit holds
   * the dialog until the answer lands and keeps it open on a refusal; a chip
   * ignores the rejection, since its refusal returns focus to it instead.
   */
  async function answer(
    input: { option?: number; note?: string },
    confirming: boolean,
    chip?: HTMLButtonElement,
  ): Promise<void> {
    if (inFlight.current) {
      throw new Error('an answer is already in flight');
    }
    inFlight.current = true;
    handoff.arm(decision.id);
    try {
      if (confirming) {
        await confirm.mutateAsync({
          id: decision.id,
          ...(input.note === undefined ? {} : { note: input.note }),
        });
      } else {
        await overturn.mutateAsync({ id: decision.id, ...input });
      }
    } catch (error) {
      if (chip) {
        setRefusal({ chip });
      }
      throw error;
    } finally {
      inFlight.current = false;
    }
  }
  async function answerFromChip(
    input: { option?: number },
    confirming: boolean,
    chip: HTMLButtonElement,
  ) {
    try {
      await answer(input, confirming, chip);
    } catch {
      // Refused or already in flight: the chip takes focus back once it is enabled.
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
                void answerFromChip(taken ? {} : { option: number }, taken, event.currentTarget)
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
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title={`Answer ${decision.id}`}
        description={<span className="wrap-anywhere">{decision.question}</span>}
        label="Note (required)"
        placeholder=""
        required
        pending={pending}
        commitDisabled={offline}
        finalFocus={() => opener.current}
        commits={[
          {
            label: 'Confirm with note',
            onCommit: (note) => answer({ note }, true),
            variant: 'outline',
          },
          {
            label: 'Answer with note',
            onCommit: (note) => answer({ note }, false),
            variant: 'outline',
          },
        ]}
      />
    </>
  );
}
