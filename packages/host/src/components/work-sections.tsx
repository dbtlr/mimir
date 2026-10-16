import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  WireNode,
  WireWorkFrontier,
  WireWorkNeedsYou,
  WireWorkNow,
  WireWorkReport,
  WireWorkShipped,
  WireWorkWaiting,
} from '../api/types';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import { ago, relativeTime } from '../lib/time';
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
import { StaleBadge } from './signal-badges';
import { StatusDot } from './status-dot';
import { Badge } from './ui/badge';
import { NeedsYouRow, RowTail, StartAction, needsYouActions } from './work-rows';

/*
 * The work page's five sections (ADR 0013, MMR-467 refinement): Now, Needs you,
 * Frontier, Shipped, and Going cold. Every row is a BrowserRow, so each is one
 * real link to its record's page, and a stale row wears the stale chip wherever
 * it appears. A row the operator can move in place carries its action from
 * work-rows: Start in Frontier's runnable rows, and a verdict or an answer in
 * Needs you.
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

export function NowRow({ row }: { row: WireWorkNow }) {
  return (
    <BrowserRow
      to={nodeLink(row.id)}
      id={row.id}
      title={row.title}
      leading={<StatusDot status={row.status} />}
      afterTitle={<RowTail row={row} />}
      meta={
        <div className="flex flex-col gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span>Started {ago(row.started_at)}</span>
            {row.harness != null && <ContextPart>{row.harness}</ContextPart>}
            {row.branch != null && <ContextPart mono>{row.branch}</ContextPart>}
            {row.scratchpads.length > 0 && <ContextPart>Scratchpad open</ContextPart>}
          </p>
          {row.latest_note !== null && (
            <p className="line-clamp-2 text-meta text-ink-dim">
              Latest note, {ago(row.latest_note.created_at)}: “{row.latest_note.content}”
            </p>
          )}
        </div>
      }
    />
  );
}

function NowSection({ rows }: { rows: readonly WireWorkNow[] }) {
  return (
    <BrowserGroup
      label="Now"
      count={rows.length > 0 ? rows.length : undefined}
      hint="What’s going on right now?"
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing running.">No task is in progress.</Empty>
      ) : (
        rows.map((row) => <NowRow key={row.id} row={row} />)
      )}
    </BrowserGroup>
  );
}

function NeedsYouSection({
  rows,
  offline,
}: {
  rows: readonly WireWorkNeedsYou[];
  offline: boolean;
}) {
  const { handoff, headingRef } = useRowFocusHandoff(rows.map((row) => row.id));
  return (
    <BrowserGroup
      label="Needs you"
      count={rows.length > 0 ? rows.length : undefined}
      hint="Only your action moves these."
      labelClassName="text-attention-foreground"
      headingRef={headingRef}
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing needs you.">No reviews, blocks, or questions are waiting.</Empty>
      ) : (
        rows.map((row) => (
          <NeedsYouRow key={row.id} row={row} actions={needsYouActions(row, offline, handoff)} />
        ))
      )}
    </BrowserGroup>
  );
}

/** A frontier row: its grooming chip and size, and what a container to break down is. */
function FrontierRow({ row, actions }: { row: WireWorkFrontier; actions?: ReactNode }) {
  return (
    <BrowserRow
      to={nodeLink(row.id)}
      id={row.id}
      title={row.title}
      leading={<StatusDot status={row.status} />}
      beforeTitle={row.break_down && <span className="microlabel text-ink-faint">{row.type}</span>}
      afterTitle={
        <>
          {row.break_down && <Badge variant="outline">break down</Badge>}
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

function UnlockGroup({ group }: { group: WireWorkReport['frontier']['next_to_unlock'][number] }) {
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
        <FrontierRow key={row.id} row={row} />
      ))}
    </div>
  );
}

function WaitingRow({ row }: { row: WireWorkWaiting }) {
  return (
    <BrowserRow
      to={nodeLink(row.id)}
      id={row.id}
      title={row.title}
      leading={<StatusDot status={row.status} />}
      afterTitle={<RowTail row={row} />}
      meta={
        row.block_reason === null ? undefined : (
          <span className="text-meta text-ink-dim">{row.block_reason}</span>
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
  frontier: WireWorkReport['frontier'];
  projectKey: string;
  home?: string;
  offline: boolean;
}) {
  const unlock = frontier.next_to_unlock.filter((g) => g.tasks.length > 0);
  const { handoff, headingRef } = useRowFocusHandoff(frontier.runnable.map((row) => row.id));
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
                  key={row.id}
                  row={row}
                  actions={<StartAction id={row.id} offline={offline} handoff={handoff} />}
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
          {frontier.to_groom.length > 0 && (
            <section aria-label="To groom">
              <SubgroupHeading name="To groom" hint="not groomed, ready or one step away" />
              {frontier.to_groom.map((row) => (
                <FrontierRow key={row.id} row={row} />
              ))}
            </section>
          )}
          {frontier.waiting_on_others.length > 0 && (
            <details>
              <summary className="microlabel cursor-pointer text-ink-faint focus-visible:outline-2 focus-visible:outline-accent">
                Waiting on others · {frontier.waiting_on_others.length}
              </summary>
              <div className="mt-1">
                {frontier.waiting_on_others.map((row) => (
                  <WaitingRow key={row.id} row={row} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </BrowserGroup>
  );
}

function ShippedRow({ row, zone }: { row: WireWorkShipped; zone: string }) {
  const abandoned = row.status === 'abandoned';
  return (
    <BrowserRow
      to={nodeLink(row.id)}
      id={row.id}
      title={row.title}
      leading={<StatusDot status={row.status} />}
      struck={abandoned}
      afterTitle={
        <span className="ml-auto font-mono text-mono-id text-ink-faint">
          {shippedTime(row.finished_at, zone)}
        </span>
      }
      meta={
        abandoned ? (
          <span className="text-meta text-ink-dim">
            Abandoned{row.abandon_reason === null ? '' : `: ${row.abandon_reason}`}
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
  rows: readonly WireWorkShipped[];
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
        <ShippedRow key={row.id} row={row} zone={zone} />
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
  rows: readonly WireWorkShipped[];
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

function GoingColdSection({ rows }: { rows: readonly WireNode[] }) {
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
            meta={<span>⧗ {relativeTime(row.updated_at)} quiet</span>}
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
}: {
  report: WireWorkReport;
  projectKey: string;
  home?: string;
  zone: string;
  offline: boolean;
}) {
  return (
    <div className="flex flex-col">
      <NowSection rows={report.now} />
      <NeedsYouSection rows={report.needs_you} offline={offline} />
      <FrontierSection
        frontier={report.frontier}
        projectKey={projectKey}
        home={home}
        offline={offline}
      />
      <ShippedSection rows={report.shipped} projectKey={projectKey} zone={zone} />
      <GoingColdSection rows={report.going_cold} />
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
