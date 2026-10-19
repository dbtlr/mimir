import type { EngineNode, Grooming } from '@mimir/contract';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useTransition } from '../api/node-mutations';
import type { NeedsYouTask } from '../api/view-queries';
import { visibleGrooming } from '../lib/grooming';
import type { Groomable } from '../lib/grooming';
import { nodeLink } from '../lib/record-url';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { transitionLabel } from '../lib/transitions';
import { useDisarmWhenSettled } from '../lib/use-row-focus-handoff';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { BrowserRow } from './browser-list';
import { GroomingBadge } from './grooming-chip';
import { GroomingDialog } from './grooming-dialog';
import { ReasonDialog } from './reason-dialog';
import { SizeBadge, StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';
import { ActionButton } from './ui/action-button';

/*
 * Task rows and their in-place actions, shared by the work page and the review
 * page at `/`, so a task that needs the operator reads and acts the same on
 * both: Start on a runnable task, Approve and Send back… on one in review, and
 * Answer… on one that needs answers. Each action's write refetches the page,
 * so the row moves to where it now belongs, and keyboard focus moves on to the
 * next row in its list (MMR-474). Offline disables them (ADR 0013 §5).
 */

/** The attention violet belongs to the rows that need the operator (ADR 0019). */
const ATTENTION_RULE = 'border-l-2 border-attention pl-2';

/** A row's trailing chips: grooming (while it still reads one), size, and stale. */
export function RowTail({
  row,
  grooming = visibleGrooming(row.task),
}: {
  row: { task: Groomable & Pick<EngineNode, 'size'>; stale: boolean };
  grooming?: Grooming;
}) {
  return (
    <>
      {grooming !== undefined && <GroomingBadge state={grooming} />}
      {row.task.size != null && <SizeBadge size={row.task.size} />}
      {row.stale && <StaleBadge />}
    </>
  );
}

/** Why a row needs the operator: in review, a block they can clear, or a question to answer. */
function NeedsYouReason({ row }: { row: NeedsYouTask }) {
  const label = {
    blocked: 'Blocked · yours',
    needs_answers: undefined,
    under_review: 'In review',
  }[row.reason];
  return label === undefined ? null : (
    <span className="microlabel text-attention-foreground">{label}</span>
  );
}

/**
 * A task that needs the operator: its reason, the hold reason on a block, and
 * the latest question on a task that needs answers. `actions` are the
 * buttons that settle it in place, when the surface offers them.
 */
export function NeedsYouRow({
  row,
  actions,
  current = false,
}: {
  row: NeedsYouTask;
  actions?: ReactNode;
  /** The row is the record on the page the operator is looking at. */
  current?: boolean;
}) {
  const holdReason = row.reason === 'blocked' ? row.task.holdReason?.trim() : undefined;
  return (
    <div className={ATTENTION_RULE}>
      <BrowserRow
        to={nodeLink(row.task.id)}
        id={row.task.id}
        title={row.task.title}
        leading={<StatusDot status={row.task.status} />}
        beforeTitle={
          <>
            <NeedsYouReason row={row} />
            {current && <span className="microlabel text-ink-faint">This page</span>}
          </>
        }
        actions={actions}
        afterTitle={
          <RowTail
            row={row}
            grooming={row.reason === 'needs_answers' ? 'needs_answers' : undefined}
          />
        }
        meta={
          <>
            {holdReason !== undefined && holdReason !== '' && (
              <p className="text-meta text-ink-dim">{holdReason}</p>
            )}
            {row.question !== null && (
              <blockquote className="mt-1 max-w-prose rounded-sm border-l-2 border-attention bg-well-850 px-2.5 py-1.5">
                <span className="microlabel block text-ink-faint">Latest question</span>
                <span className="text-meta whitespace-pre-line text-attention-foreground">
                  {row.question}
                </span>
              </blockquote>
            )}
          </>
        }
      />
    </div>
  );
}

/**
 * What every row action takes: its task, whether the console is offline, and
 * its section's focus handoff, armed as the operator commits to an action and
 * disarmed if the action ends with the row still in place.
 */
type RowActionProps = { id: string; offline: boolean; handoff: RowFocusHandoff };

/**
 * Each action owns its mutation, so only the rows that can act mount one.
 * Every write invalidates the work reads (useTransition, useGroom).
 */
export function StartAction({ id, offline, handoff }: RowActionProps) {
  const { mutate, isPending, submittedAt } = useTransition(id);
  useDisarmWhenSettled(handoff, id, isPending ? null : submittedAt);
  return (
    <ActionButton
      size="sm"
      className={PHONE_TOUCH_TARGET}
      disabled={offline || isPending}
      onClick={() => {
        handoff.arm(id);
        mutate({ verb: 'start' });
      }}
    >
      Start
    </ActionButton>
  );
}

/** Approve (`done`) and Send back… (`return`, with an optional reason), as on the task page. */
function VerdictActions({ id, offline, handoff }: RowActionProps) {
  const { mutate, isPending, submittedAt } = useTransition(id);
  const [sendingBack, setSendingBack] = useState(false);
  // The dialog is not this button's popup, so it is told where focus goes back to.
  const sendBackRef = useRef<HTMLButtonElement>(null);
  useDisarmWhenSettled(handoff, id, isPending ? null : submittedAt);
  return (
    <>
      <ActionButton
        size="sm"
        variant="attention"
        className={PHONE_TOUCH_TARGET}
        disabled={offline || isPending}
        onClick={() => {
          handoff.arm(id);
          mutate({ verb: 'done' });
        }}
      >
        Approve
      </ActionButton>
      <ActionButton
        ref={sendBackRef}
        size="sm"
        variant="outline"
        className={PHONE_TOUCH_TARGET}
        disabled={offline || isPending}
        onClick={() => setSendingBack(true)}
      >
        {transitionLabel('return')}…
      </ActionButton>
      <ReasonDialog
        verb="return"
        finalFocus={sendBackRef}
        open={sendingBack}
        onClose={() => setSendingBack(false)}
        onConfirm={(reason) => {
          handoff.arm(id);
          mutate(reason === '' ? { verb: 'return' } : { reason, verb: 'return' });
          setSendingBack(false);
        }}
      />
    </>
  );
}

/** Answer… writes the answer as a note and sets the grooming state the operator picks. */
function AnswerAction({
  id,
  question,
  offline,
  handoff,
}: RowActionProps & { question: string | null }) {
  const [answering, setAnswering] = useState(false);
  // Each opening counts, so every close reads as a newly settled action.
  const [opened, setOpened] = useState(0);
  useDisarmWhenSettled(handoff, id, answering ? null : opened);
  return (
    <>
      <ActionButton
        size="sm"
        variant="attentionOutline"
        className={PHONE_TOUCH_TARGET}
        disabled={offline}
        onClick={() => {
          // The answer is written from the dialog, which leaves with the row.
          handoff.arm(id);
          setOpened((n) => n + 1);
          setAnswering(true);
        }}
      >
        Answer…
      </ActionButton>
      {answering && (
        <GroomingDialog
          mode="answer"
          nodeId={id}
          question={question}
          open
          onClose={() => setAnswering(false)}
        />
      )}
    </>
  );
}

/** What a needs-you row offers: a verdict, an answer, or nothing for a block. */
export function needsYouActions(
  row: NeedsYouTask,
  offline: boolean,
  handoff: RowFocusHandoff,
): ReactNode {
  if (row.reason === 'under_review') {
    return <VerdictActions id={row.task.id} offline={offline} handoff={handoff} />;
  }
  if (row.reason === 'needs_answers') {
    return (
      <AnswerAction id={row.task.id} question={row.question} offline={offline} handoff={handoff} />
    );
  }
  return undefined;
}
