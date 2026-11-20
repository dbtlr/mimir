import { useState } from 'react';

import { useCancelGroom } from '../api/agent-queries';
import type { GroomCancelResult } from '../api/fns/agent';
import { cancelAnswerText, formatTokens } from '../lib/agent-card';
import { DestructiveConfirm } from './patterns/destructive-confirm';

/*
 * Stopping an agent run (ADR 0041's cancel refinement, MMR-635): the confirm
 * both the task page's card and the work page's Now row open, as a Destructive
 * confirm (ADR 0019, MMR-736). The dialog opens on Keep running, the safe
 * choice; Escape closes it and focus returns to the control that opened it. A
 * recorded cancel closes it. Any other answer replaces the question with one
 * sentence saying why nothing changed.
 */

/** The run a stop acts on, as it read when the operator opened the dialog. */
export type StopTarget = { runId: string; task: string; usedTokens: number };

type Refusal = Exclude<GroomCancelResult, { state: 'cancelling' }>;

/**
 * The stop confirm, for the run `target` names. The caller mounts it only
 * while it is open, as the grooming dialog's callers do: closing unmounts the
 * whole dialog, so each opening starts with the question.
 */
export function StopRunDialog({ target, onClose }: { target: StopTarget; onClose: () => void }) {
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const stop = useCancelGroom((answer) => {
    if (answer.state === 'cancelling') {
      onClose();
    } else {
      setRefusal(answer);
    }
  });
  return (
    <DestructiveConfirm
      open
      onClose={onClose}
      title={`Stop the agent on ${target.task}?`}
      cancelLabel="Keep running"
      commitLabel="Stop run"
      pending={stop.isPending}
      // The answer closes the dialog, or replaces the question.
      closeOnCommit={false}
      answer={refusal === undefined ? undefined : cancelAnswerText(refusal)}
      onConfirm={async () => {
        await stop.mutateAsync({ runId: target.runId });
      }}
    >
      <div className="flex flex-col gap-2">
        <span>It finishes the step it is on, then stops: usually seconds, at most 5 minutes.</span>
        <span>
          Notes it already wrote stay on the task. The {formatTokens(target.usedTokens)} tokens it
          has used so far count toward today&apos;s budget.
        </span>
      </div>
    </DestructiveConfirm>
  );
}
