import type { EngineNode } from '@mimir/contract';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  FrontierTask,
  NeedsYouTask,
  NowTask,
  ShippedTask,
  WaitingTask,
  WorkReport,
} from '../api/view-queries';
import type { AgentRun } from '../lib/agent-card';
import { formatTokens } from '../lib/agent-card';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import { ago, relativeTime } from '../lib/time';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { useRowFocusHandoff } from '../lib/use-row-focus-handoff';
import {
  SHIPPED_DAY_CAP,
  capDay,
  frontierIsEmpty,
  groupShippedByDay,
  shippedTime,
} from '../lib/work-page';
import { BrowserGroup, BrowserRow } from './browser-list';
import { NewTaskButton } from './new-task-button';
import { OpenInT3 } from './open-in-t3';
import { StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';
import { StopRunDialog } from './stop-run-dialog';
import type { StopTarget } from './stop-run-dialog';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';
import { NeedsYouRow, RowTail, StartAction, needsYouActions } from './work-rows';

/*
 * The work page's five sections (ADR 0013, MMR-467 refinement): Now, Needs you,
 * Frontier, Shipped, and Going cold. Every row is a BrowserRow, so each is one
 * real link to its record's page, and a stale row wears the stale chip wherever
 * it appears. A row the operator can move in place carries its action from
 * work-rows: Start in Frontier's runnable rows, and an answer in Needs you.
 * A task in review reads in Now, without actions: its verdict is on its page.
 */

/** An empty section's line: a bold lead and what its emptiness means. */
export function Empty({ lead, children }: { lead: string; children?: ReactNode }) {
  return (
    <p className="px-1 py-2 text-xs text-ink-faint">
      <strong className="font-semibold text-ink-dim">{lead}</strong>
      {children !== undefined && <> {children}</>}
    </p>
  );
}

/** One part of a Now row's agent context, set off from the one before by a middle dot. */
function ContextPart({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className="flex gap-1.5">
      <span aria-hidden>·</span>
      <span className={cn(mono && 'font-mono break-all')}>{children}</span>
    </span>
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
function useRowStop(run: AgentRun | undefined): { button: ReactNode; dialog: ReactNode } {
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
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            {row.task.status === 'under_review' || row.task.status === 'staged' ? (
              <>
                <span>{row.task.status === 'staged' ? 'Staged' : 'In review'}</span>
                <ContextPart>submitted {ago(row.submittedAt ?? row.startedAt)}</ContextPart>
              </>
            ) : (
              <span>
                {row.task.status === 'queued' ? 'Queued' : 'Started'} {ago(row.startedAt)}
              </span>
            )}
            {row.task.harness != null && <ContextPart>{row.task.harness}</ContextPart>}
            {row.task.workerSession != null && (
              <ContextPart>
                worker {row.task.workerHarness != null && `${row.task.workerHarness} `}
                {row.task.workerSession}
              </ContextPart>
            )}
            {row.task.branch != null && <ContextPart mono>{row.task.branch}</ContextPart>}
            {row.scratchpads.length > 0 && <ContextPart>Scratchpad open</ContextPart>}
            {agent !== undefined && (
              <ContextPart>
                Agent {agent.stopping ? 'stopping after its current step' : 'grooming'}
                {agent.stale ? ', stopped reporting' : ''}
              </ContextPart>
            )}
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
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span>
            {run.stopping
              ? 'Stopping after its current step'
              : `Grooming, started ${ago(run.startedAt)}`}
          </span>
          {run.stale && <ContextPart>stopped reporting</ContextPart>}
          <ContextPart>
            {formatTokens(run.usedTokens)} of {formatTokens(run.reservedTokens)} tokens
          </ContextPart>
        </p>
      }
      actions={stopButton}
    />
  );
}

function NowSection({ rows, agentRun }: { rows: readonly NowTask[]; agentRun: AgentRun | null }) {
  // A task already in Now (queued while the agent grooms it) carries the agent on its own row.
  const agentOnRow = agentRun !== null && rows.some((row) => row.task.id === agentRun.task);
  const agentRow = agentOnRow ? null : agentRun;
  // The section owns the confirm, so its answer outlives the row of a run that just ended.
  const stop = useRowStop(agentRun ?? undefined);
  const count = rows.length + (agentRow === null ? 0 : 1);
  return (
    <BrowserGroup
      label="Now"
      count={count > 0 ? count : undefined}
      hint="What’s going on right now?"
    >
      {count === 0 ? (
        <Empty lead="Nothing running.">No task is queued, in progress, or in review.</Empty>
      ) : (
        <>
          {agentRow !== null && <AgentNowRow run={agentRow} stopButton={stop.button} />}
          {rows.map((row) => {
            const agent = agentRun?.task === row.task.id ? agentRun : undefined;
            return (
              <NowRow
                key={row.task.id}
                row={row}
                agent={agent}
                stopButton={agent === undefined ? undefined : stop.button}
              />
            );
          })}
        </>
      )}
      {stop.dialog}
    </BrowserGroup>
  );
}

function NeedsYouSection({ rows, offline }: { rows: readonly NeedsYouTask[]; offline: boolean }) {
  const { handoff, headingRef } = useRowFocusHandoff(rows.map((row) => row.task.id));
  return (
    <BrowserGroup
      label="Needs you"
      count={rows.length > 0 ? rows.length : undefined}
      hint="Only your action moves these."
      labelClassName="text-attention-foreground"
      headingRef={headingRef}
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing needs you.">No blocks or questions are waiting.</Empty>
      ) : (
        rows.map((row) => (
          <NeedsYouRow
            key={row.task.id}
            row={row}
            actions={needsYouActions(row, offline, handoff)}
          />
        ))
      )}
    </BrowserGroup>
  );
}

/** A frontier row: its grooming chip and size, and what a container to break down is. */
function FrontierRow({ row, actions }: { row: FrontierTask; actions?: ReactNode }) {
  return (
    <BrowserRow
      to={nodeLink(row.task.id)}
      id={row.task.id}
      title={row.task.title}
      leading={<StatusDot status={row.task.status} />}
      beforeTitle={
        row.breakDown && <span className="microlabel text-ink-faint">{row.task.type}</span>
      }
      afterTitle={
        <>
          {row.breakDown && <Badge variant="outline">break down</Badge>}
          <RowTail row={row} />
        </>
      }
      actions={actions}
    />
  );
}

/** A frontier subgroup's heading: its name, and the plain-type reading of what it holds. */
function SubgroupHeading({ name, hint }: { name: string; hint: string }) {
  return (
    <h3 className="microlabel mb-1 text-ink-faint">
      {name}
      <span className="ml-2 font-sans text-meta font-normal tracking-normal text-ink-dim normal-case">
        {hint}
      </span>
    </h3>
  );
}

function UnlockGroup({ group }: { group: WorkReport['frontier']['nextToUnlock'][number] }) {
  return (
    <div className="mt-1.5">
      <p className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 text-tag">
        <span className="microlabel text-ink-faint">After</span>{' '}
        <Link
          {...nodeLink(group.prerequisite.id)}
          className="font-mono text-mono-id text-accent-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          {group.prerequisite.id}
        </Link>
        {group.prerequisite.title !== undefined && (
          <span className="text-ink-dim">{group.prerequisite.title}</span>
        )}
      </p>
      {group.tasks.map((row) => (
        <FrontierRow key={row.task.id} row={row} />
      ))}
    </div>
  );
}

function WaitingRow({ row }: { row: WaitingTask }) {
  return (
    <BrowserRow
      to={nodeLink(row.task.id)}
      id={row.task.id}
      title={row.task.title}
      leading={<StatusDot status={row.task.status} />}
      afterTitle={<RowTail row={row} />}
      meta={
        row.blockReason === null ? undefined : (
          <span className="text-meta text-ink-dim">{row.blockReason}</span>
        )
      }
    />
  );
}

/** The frontier: work one step from startable, split by what the operator can do with it. */
function FrontierSection({
  frontier,
  projectKey,
  home,
  offline,
}: {
  frontier: WorkReport['frontier'];
  projectKey: string;
  home?: string;
  offline: boolean;
}) {
  const unlock = frontier.nextToUnlock.filter((g) => g.tasks.length > 0);
  const { handoff, headingRef } = useRowFocusHandoff(frontier.runnable.map((row) => row.task.id));
  return (
    <BrowserGroup label="Frontier" hint="What’s next, and who can take it?" headingRef={headingRef}>
      {frontierIsEmpty(frontier) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Empty lead="The frontier is empty.">No task is ready or one step from ready.</Empty>
          <NewTaskButton projectKey={projectKey} home={home} offline={offline} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <section aria-label="Runnable now">
            <SubgroupHeading name="Runnable now" hint="groomed and ready" />
            {frontier.runnable.length === 0 ? (
              <Empty lead="Nothing runnable yet." />
            ) : (
              frontier.runnable.map((row) => (
                <FrontierRow
                  key={row.task.id}
                  row={row}
                  actions={<StartAction id={row.task.id} offline={offline} handoff={handoff} />}
                />
              ))
            )}
          </section>
          {unlock.length > 0 && (
            <section aria-label="Next to unlock">
              <SubgroupHeading
                name="Next to unlock"
                hint="groomed, waiting only on work in flight"
              />
              {unlock.map((group) => (
                <UnlockGroup key={group.prerequisite.id} group={group} />
              ))}
            </section>
          )}
          {frontier.toGroom.length > 0 && (
            <section aria-label="To groom">
              <SubgroupHeading name="To groom" hint="not groomed, ready or one step away" />
              {frontier.toGroom.map((row) => (
                <FrontierRow key={row.task.id} row={row} />
              ))}
            </section>
          )}
          {frontier.waitingOnOthers.length > 0 && (
            <details>
              <summary className="microlabel cursor-pointer text-ink-faint focus-visible:outline-2 focus-visible:outline-accent">
                Waiting on others · {frontier.waitingOnOthers.length}
              </summary>
              <div className="mt-1">
                {frontier.waitingOnOthers.map((row) => (
                  <WaitingRow key={row.task.id} row={row} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </BrowserGroup>
  );
}

function ShippedRow({ row, zone }: { row: ShippedTask; zone: string }) {
  const abandoned = row.task.status === 'abandoned';
  return (
    <BrowserRow
      to={nodeLink(row.task.id)}
      id={row.task.id}
      title={row.task.title}
      leading={<StatusDot status={row.task.status} />}
      struck={abandoned}
      afterTitle={
        <span className="ml-auto font-mono text-mono-id text-ink-faint">
          {shippedTime(row.finishedAt, zone)}
        </span>
      }
      meta={
        abandoned ? (
          <span className="text-meta text-ink-dim">
            Abandoned
            {row.abandonReason === null ? '' : `: ${row.abandonReason}`}
          </span>
        ) : undefined
      }
    />
  );
}

/** One Shipped day: its first rows, and an in-place "N more" for the rest. */
export function ShippedDayGroup({
  label,
  rows,
  zone,
}: {
  label: string;
  rows: readonly ShippedTask[];
  zone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const dayRef = useRef<HTMLDivElement>(null);
  const justExpanded = useRef(false);
  const { shown, hidden } = capDay(rows, expanded);
  // The "N more" button unmounts as it is pressed, which would drop focus to
  // the page; hand it to the first row it revealed.
  useEffect(() => {
    if (expanded && justExpanded.current) {
      justExpanded.current = false;
      dayRef.current?.querySelectorAll('a')[SHIPPED_DAY_CAP]?.focus();
    }
  }, [expanded]);
  return (
    <div ref={dayRef} className="mt-1.5">
      <h3 className="mb-0.5 font-mono text-tag text-ink-faint">{label}</h3>
      {shown.map((row) => (
        <ShippedRow key={row.task.id} row={row} zone={zone} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          aria-label={`Show ${String(hidden)} more shipped on ${label}`}
          onClick={() => {
            justExpanded.current = true;
            setExpanded(true);
          }}
          className={cn(
            'ml-1 rounded-sm px-1 py-1 text-xs text-accent-foreground transition-colors',
            'hover:text-accent focus-visible:outline-2 focus-visible:outline-accent',
          )}
        >
          {hidden} more
        </button>
      )}
    </div>
  );
}

function ShippedSection({
  rows,
  projectKey,
  zone,
}: {
  rows: readonly ShippedTask[];
  projectKey: string;
  zone: string;
}) {
  return (
    <BrowserGroup
      label="Shipped"
      count={rows.length > 0 ? rows.length : undefined}
      hint="What landed in the last 7 days?"
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing shipped in the last 7 days.">
          <Link
            to="/p/$key/tasks"
            params={{ key: projectKey }}
            search={{ status: 'terminal' }}
            className="text-accent-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Finished tasks →
          </Link>
        </Empty>
      ) : (
        groupShippedByDay(rows, zone).map((day) => (
          <ShippedDayGroup key={day.day} label={day.label} rows={day.rows} zone={zone} />
        ))
      )}
    </BrowserGroup>
  );
}

function GoingColdSection({ rows }: { rows: readonly EngineNode[] }) {
  return (
    <BrowserGroup
      label="Going cold"
      count={rows.length > 0 ? rows.length : undefined}
      hint="What has nobody touched in a while?"
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing stale.">Everything here has moved recently.</Empty>
      ) : (
        rows.map((row) => (
          <BrowserRow
            key={row.id}
            to={nodeLink(row.id)}
            id={row.id}
            title={row.title}
            leading={<StatusDot status={row.status} />}
            afterTitle={<StaleBadge />}
            meta={<span>⧗ {relativeTime(row.updatedAt)} quiet</span>}
          />
        ))
      )}
    </BrowserGroup>
  );
}

/**
 * The five sections in question order, from one work read, then a link to the
 * project's task browser. `home` is the
 * container the page is scoped to, so the empty frontier's New task files
 * into it; a project passes none.
 */
export function WorkSections({
  report,
  projectKey,
  home,
  zone,
  offline,
  agentRun = null,
}: {
  report: WorkReport;
  projectKey: string;
  home?: string;
  zone: string;
  offline: boolean;
  /** The running agent run in this page's scope, if any. */
  agentRun?: AgentRun | null;
}) {
  return (
    <div className="flex flex-col">
      <NowSection rows={report.now} agentRun={agentRun} />
      <NeedsYouSection rows={report.needsYou} offline={offline} />
      <FrontierSection
        frontier={report.frontier}
        projectKey={projectKey}
        home={home}
        offline={offline}
      />
      <ShippedSection rows={report.shipped} projectKey={projectKey} zone={zone} />
      <GoingColdSection rows={report.goingCold} />
      {/* The other lens on the scope: its tasks in the browser, past the five sections. */}
      <Link
        to="/p/$key/tasks"
        params={{ key: projectKey }}
        className="mt-1 border-t border-line px-1 py-2.5 text-meta text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        All tasks in {projectKey} →
      </Link>
    </div>
  );
}
