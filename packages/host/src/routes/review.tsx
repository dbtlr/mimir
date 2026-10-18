import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { browserTimeZone } from '../api/queries';
import { archivedProjectsQuery } from '../api/shell-queries';
import type { WireReviewReport } from '../api/types';
import { reviewQuery } from '../api/view-queries';
import { BrowserGroup } from '../components/browser-list';
import { DecisionGroups } from '../components/decision-groups';
import { FocusQueue } from '../components/focus-queue';
import { NewProjectSheet } from '../components/new-project-sheet';
import { OfflineBanner } from '../components/offline-banner';
import { RecordLayout, RecordPending } from '../components/record-layout';
import { ReviewRail } from '../components/review-rail';
import { ActionButton, actionButtonVariants } from '../components/ui/action-button';
import { Empty, NowRow, ShippedDayGroup } from '../components/work-sections';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeLink } from '../lib/record-url';
import { ago } from '../lib/time';
import { useRowFocusHandoff } from '../lib/use-row-focus-handoff';
import { groupShippedByDay } from '../lib/work-page';
import { reviewRoute } from '../router';

/*
 * `/` — the review page (ADR 0013 and ADR 0019, MMR-503 refinement): the work
 * page's cross-project counterpart. The main column is Needs you (the decisions,
 * grouped by project), Now, and Shipped, in the work page's row style; the rail
 * holds the project health strip and what can wait for a spare minute. One read
 * (`/api/review`) feeds all of it, and the top-bar alert reads the same entry,
 * so their counts never disagree.
 *
 * Rows act in place (MMR-479): a decision carries the work page's verdict or
 * answer, a runnable task its Start, and a listed seed its triage verbs. When
 * an acted-on row leaves, keyboard focus moves on to the next row in its
 * section, or to the section's heading when none follows.
 */

/** `1 task` / `2 tasks` — a count with its noun, singular at one. */
const counted = (n: number, one: string): string => `${String(n)} ${n === 1 ? one : `${one}s`}`;

/** What the rail is, for assistive technology. */
const RAIL_LABEL = 'Projects and spare-minute work';

function ReviewHead({ count }: { count: number }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
          {count > 0 ? (
            <>
              Needs you <span className="font-normal text-ink-faint">{count}</span>
            </>
          ) : (
            'Nothing needs you'
          )}
        </h1>
        <p className="text-meta text-ink-dim">
          Decisions block agents, so they lead. The rail holds what can wait.
        </p>
      </div>
      {count > 0 && (
        <Link
          to="/"
          search={{ mode: 'focus' }}
          className={cn(
            actionButtonVariants({ variant: 'attention' }),
            'max-md:min-h-11 max-md:w-full',
          )}
        >
          Work through these · {count}
        </Link>
      )}
    </header>
  );
}

/** Needs you's all-clear: nothing waits, so name the work in flight and the last finish. */
function AllClear({
  inFlight,
  last,
}: {
  inFlight: number;
  last: WireReviewReport['last_finished'];
}) {
  return (
    <p className="px-1 py-2 text-xs text-ink-faint">
      <strong className="font-semibold text-ink-dim">
        No verdicts, blocks, or questions are waiting.
      </strong>{' '}
      {inFlight > 0
        ? `Agents are working on ${counted(inFlight, 'task')}.`
        : 'No task is in progress.'}
      {last !== null && (
        <>
          {' '}
          Last finished: <span className="font-mono">{last.id}</span>{' '}
          <Link {...nodeLink(last.id)} className="text-ink-dim underline-offset-2 hover:underline">
            {last.title}
          </Link>
          {last.status === 'abandoned' && ' (abandoned)'}, {ago(last.finished_at)}.
        </>
      )}
    </p>
  );
}

function NeedsYouSection({ report, offline }: { report: WireReviewReport; offline: boolean }) {
  const count = report.queue.length;
  const inFlight = report.projects.reduce((n, p) => n + p.in_flight, 0);
  const { handoff, headingRef } = useRowFocusHandoff(
    report.decisions.flatMap((group) => group.rows.map((row) => row.id)),
  );
  return (
    <BrowserGroup
      label="Needs you"
      count={count > 0 ? count : undefined}
      hint="Only your action moves these."
      labelClassName="text-attention-foreground"
      headingRef={headingRef}
    >
      {report.decisions.length === 0 ? (
        <AllClear inFlight={inFlight} last={report.last_finished} />
      ) : (
        <DecisionGroups groups={report.decisions} offline={offline} handoff={handoff} />
      )}
    </BrowserGroup>
  );
}

/** The tasks in progress across active projects; a row's id leads with its project key. */
function NowSection({ rows }: { rows: WireReviewReport['now'] }) {
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

/** What landed in the last 7 days across active projects, grouped by day as on the work page. */
function ShippedSection({ rows }: { rows: WireReviewReport['shipped'] }) {
  const zone = browserTimeZone();
  return (
    <BrowserGroup
      label="Shipped"
      count={rows.length > 0 ? rows.length : undefined}
      hint="What landed in the last 7 days?"
    >
      {rows.length === 0 ? (
        <Empty lead="Nothing shipped in the last 7 days." />
      ) : (
        groupShippedByDay(rows, zone).map((day) => (
          <ShippedDayGroup key={day.day} label={day.label} rows={day.rows} zone={zone} />
        ))
      )}
    </BrowserGroup>
  );
}

export function ReviewPage() {
  const { mode } = reviewRoute.useSearch();
  const [creating, setCreating] = useState(false);
  const review = useQuery(reviewQuery());
  const archived = useQuery(archivedProjectsQuery);
  const conn = connectivity([review, archived]);
  const sheet = <NewProjectSheet open={creating} onOpenChange={setCreating} />;

  if (review.data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={review.isError} />
      </>
    );
  }
  const report = review.data;

  // Only a confirmed-empty archive makes a fresh store: an archived read still
  // in flight, or failed, may yet hold every project.
  if (report.projects.length === 0 && archived.data?.length === 0) {
    // A fresh store's one useful action is creating a project.
    return (
      <>
        <OfflineBanner {...conn} />
        <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-start gap-3 p-5">
          <p className="text-xs text-ink-dim">No projects yet.</p>
          <ActionButton
            className="px-3.5 py-1.5"
            disabled={conn.offline}
            onClick={() => setCreating(true)}
          >
            + New project
          </ActionButton>
        </main>
        {sheet}
      </>
    );
  }

  if (mode === 'focus') {
    return (
      <>
        <OfflineBanner {...conn} />
        <FocusQueue offline={conn.offline} />
      </>
    );
  }

  return (
    <>
      <OfflineBanner {...conn} />
      <RecordLayout
        head={<ReviewHead count={report.queue.length} />}
        rail={<ReviewRail report={report} offline={conn.offline} />}
        railLabel={RAIL_LABEL}
        className={cn(conn.offline && 'offline-demoted')}
      >
        <NeedsYouSection report={report} offline={conn.offline} />
        <NowSection rows={report.now} />
        <ShippedSection rows={report.shipped} />
      </RecordLayout>
    </>
  );
}
