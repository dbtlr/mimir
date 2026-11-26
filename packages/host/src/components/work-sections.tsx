import { useState } from 'react';
import type { ReactNode } from 'react';

import type { NowTask } from '../api/view-queries';
import type { AgentRun } from '../lib/agent-card';
import { formatTokens } from '../lib/agent-card';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import { STATUS_META } from '../lib/status';
import { ago } from '../lib/time';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { BrowserRow } from './browser-list';
import { MetaPart } from './meta-part';
import { OpenInT3 } from './open-in-t3';
import { StatusWord } from './status-badge';
import { StatusDot } from './status-dot';
import { StopRunDialog } from './stop-run-dialog';
import type { StopTarget } from './stop-run-dialog';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';
import { RowTail } from './work-rows';

/*
 * The rows for work in flight that the work page's old sections drew, kept for
 * the pages that still list with them: a Now row (a delivery's members), and a
 * running agent's row with its Stop (ADR 0041), which a scoped Work tab sets
 * above Now's cards when the run's task has no card of its own (ADR 0013,
 * MMR-727 refinement). Every row is a BrowserRow, one real link to its
 * record's page.
 */

/** An empty section's line: a bold lead and what its emptiness means. */
export function Empty({ lead, children }: { lead: string; children?: ReactNode }) {
  return (
    <p className="px-1 py-2 text-xs text-ink-dim">
      <strong className="font-semibold text-ink-dim">{lead}</strong>
      {children !== undefined && <> {children}</>}
    </p>
  );
}

/**
 * A Now row's stop (ADR 0041's cancel refinement): the icon button the row
 * offers while its agent run can be stopped, and the confirm it opens. The
 * confirm keeps the run it opened on, so a poll that swaps the running run
 * while it is open cannot redirect the stop. The confirm lives outside the
 * row's actions and its section renders it, so a refusal stays readable after a
 * refresh hides the button or removes the row of a run that just ended.
 */
export function useRowStop(run: AgentRun | undefined): { button: ReactNode; dialog: ReactNode } {
  const [target, setTarget] = useState<StopTarget | null>(null);
  const button =
    run?.cancellable === true ? (
      <ActionButton
        size="sm"
        variant="destructiveOutline"
        aria-label={`Stop run on ${run.task}`}
        title="Stop run"
        className={cn('min-w-8 px-2', PHONE_TOUCH_TARGET, 'max-md:min-w-11')}
        onClick={() => {
          setTarget({ runId: run.id, task: run.task, usedTokens: run.usedTokens });
        }}
      >
        <span aria-hidden className="size-2.5 rounded-[2px] bg-current" />
      </ActionButton>
    ) : undefined;
  const dialog =
    target === null ? null : (
      <StopRunDialog
        target={target}
        onClose={() => {
          setTarget(null);
        }}
      />
    );
  return { button, dialog };
}

/** The Stopping badge of an agent run with a recorded cancel, until its row closes. */
function StoppingBadge({ run }: { run: AgentRun | undefined }) {
  return run?.stopping === true ? <Badge variant="outline">Stopping</Badge> : null;
}

/**
 * A Now task's row; `agent` is the agent run grooming it, when one is, and
 * `stopButton` the control its section offers to stop that run.
 */
export function NowRow({
  row,
  agent,
  stopButton,
}: {
  row: NowTask;
  agent?: AgentRun;
  stopButton?: ReactNode;
}) {
  return (
    <BrowserRow
      to={nodeLink(row.task.id)}
      id={row.task.id}
      title={row.task.title}
      leading={<StatusDot status={row.task.status} />}
      afterTitle={
        <>
          <RowTail row={row} />
          <StoppingBadge run={agent} />
        </>
      }
      actions={stopButton}
      meta={
        <div className="flex flex-col gap-0.5">
          <p>
            {row.task.status === 'under_review' || row.task.status === 'staged' ? (
              <>
                <StatusWord>{STATUS_META[row.task.status].label}</StatusWord>
                <MetaPart>submitted {ago(row.submittedAt ?? row.startedAt)}</MetaPart>
              </>
            ) : (
              <span>
                {row.task.status === 'queued' ? (
                  <StatusWord>{STATUS_META.queued.label}</StatusWord>
                ) : (
                  'Started'
                )}{' '}
                {ago(row.startedAt)}
              </span>
            )}
            {row.task.harness != null && <MetaPart>{row.task.harness}</MetaPart>}
            {row.task.workerSession != null && (
              <MetaPart>
                worker {row.task.workerHarness != null && `${row.task.workerHarness} `}
                {row.task.workerSession}
              </MetaPart>
            )}
            {row.task.branch != null && <MetaPart mono>{row.task.branch}</MetaPart>}
            {row.scratchpads.length > 0 && <MetaPart>Scratchpad open</MetaPart>}
            {agent !== undefined && (
              <MetaPart>
                Agent {agent.stopping ? 'stopping after its current step' : 'grooming'}
                {agent.stale ? ', stopped reporting' : ''}
              </MetaPart>
            )}{' '}
            <OpenInT3 harness={row.task.harness} host={row.task.host} session={row.task.session} />
          </p>
          {row.latestNote !== null && (
            <p className="line-clamp-2 text-meta text-ink-dim">
              Latest note, {ago(row.latestNote.createdAt)}: “{row.latestNote.content}”
            </p>
          )}
        </div>
      }
    />
  );
}

/**
 * An agent run's facts on its task's Now card (a scoped page, MMR-727): what
 * it is doing, whether it stopped reporting, and its tokens, as its row says.
 */
export function AgentFacts({ run }: { run: AgentRun }) {
  return (
    <>
      Agent{' '}
      {run.stopping ? 'stopping after its current step' : `grooming, started ${ago(run.startedAt)}`}
      {run.stale ? ', stopped reporting' : ''}
      <MetaPart>
        {formatTokens(run.usedTokens)} of {formatTokens(run.reservedTokens)} tokens
      </MetaPart>
    </>
  );
}

/** The agent run grooming a task in this page's scope, as a Now row, with its section's stop control. */
export function AgentNowRow({ run, stopButton }: { run: AgentRun; stopButton?: ReactNode }) {
  return (
    <BrowserRow
      to={nodeLink(run.task)}
      id={run.task}
      title={run.taskTitle ?? run.task}
      leading={<StatusDot status="in_progress" />}
      afterTitle={
        <>
          <Badge variant="outline">Agent</Badge>
          <StoppingBadge run={run} />
        </>
      }
      meta={
        <p>
          <span>
            {run.stopping
              ? 'Stopping after its current step'
              : `Grooming, started ${ago(run.startedAt)}`}
          </span>
          {run.stale && <MetaPart>stopped reporting</MetaPart>}
          <MetaPart>
            {formatTokens(run.usedTokens)} of {formatTokens(run.reservedTokens)} tokens
          </MetaPart>
        </p>
      }
      actions={stopButton}
    />
  );
}
