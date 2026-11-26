import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { browserTimeZone } from '../api/queries';
import { archivedProjectsQuery } from '../api/shell-queries';
import { reviewQuery } from '../api/view-queries';
import type { ReviewReport } from '../api/view-queries';
import { FocusQueue } from '../components/focus-queue';
import {
  MinuteSection,
  NowSection,
  ShippedByProject,
  ShippedSection,
} from '../components/home-sections';
import { NeedsYouDeck } from '../components/needs-you-deck';
import { needsYouCards } from '../components/needs-you-deck-model';
import { NewProjectSheet } from '../components/new-project-sheet';
import { OfflineBanner } from '../components/offline-banner';
import { PushSuggestion } from '../components/push-suggestion';
import { RecordPending } from '../components/record-layout';
import { ActionButton } from '../components/ui/action-button';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { homeDay, homeSummary, minuteRows, oneProject, shippedWeek } from '../lib/home';
import { PAGE_COLUMN } from '../lib/page-column';
import { presetLink } from '../lib/task-list';
import { reviewRoute } from '../router';

/*
 * `/` — Home (ADR 0013, MMR-722 refinement): one feed column. The page title
 * names the day and one sentence under it says what needs you, what runs,
 * and what shipped this week. Then the one-time notifications card when it
 * applies (MMR-734), Needs you as the ranked deck with See all to the Needs
 * you page (MMR-723), Now as capped title cards,
 * the Shipped week, and what can wait for a spare minute. Projects live in
 * the sidebar, so the page has no rail. One read (`console.review`) feeds all
 * of it, and the top-bar alert reads the same entry. `?mode=focus` is the
 * focus queue, unchanged.
 */

/** The page title and the summary sentence, over a hairline. */
function HomeHead({
  report,
  shipped,
  zone,
}: {
  report: ReviewReport;
  /** This week's shipped total, from the week Shipped draws. */
  shipped: number;
  zone: string;
}) {
  const cards = useMemo(() => needsYouCards(report).length, [report]);
  return (
    <header className="mb-8 border-b border-line pb-5">
      <h1 className="m-0 text-page leading-9 font-bold text-ink-bright">{homeDay(zone)}</h1>
      <p className="mt-1 mb-0 max-w-[62ch] text-body text-pretty text-ink">
        {homeSummary({ cards, items: report.queue.length, running: report.now.length, shipped })}
      </p>
    </header>
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
        <main className={cn(PAGE_COLUMN, 'flex flex-1 flex-col items-start gap-3 p-5')}>
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

  const zone = browserTimeZone();
  // One pass over the shipped rows feeds the summary's total and the Shipped section.
  const week = shippedWeek({ projects: report.projects, rows: report.shipped, zone });
  const names = new Map(report.projects.map((project) => [project.key, project.name]));
  // Now opens its project's In flight only when every task in it is one project's (MMR-724).
  const nowProject = oneProject(report.now.map((row) => row.project));
  return (
    <>
      <OfflineBanner {...conn} />
      {/* tabIndex -1: a focus fallback for a control that unmounts itself (focusMain). */}
      <main
        tabIndex={-1}
        className={cn('min-h-0 flex-1 overflow-y-auto', conn.offline && 'offline-demoted')}
      >
        <div className={cn(PAGE_COLUMN, 'px-3.5 pt-4 pb-10 md:px-5 md:pt-6 md:pb-12')}>
          <HomeHead report={report} shipped={week.total} zone={zone} />
          <PushSuggestion offline={conn.offline} />
          <NeedsYouDeck
            report={report}
            offline={conn.offline}
            countItems
            seeAll={{ to: '/needs-you' }}
          />
          <NowSection
            rows={report.now}
            names={names}
            seeAll={nowProject === undefined ? undefined : presetLink(nowProject, 'in-flight')}
          />
          <ShippedSection
            days={week.days}
            total={week.total}
            breakdown={<ShippedByProject week={week} />}
          />
          <MinuteSection rows={minuteRows(report)} />
        </div>
      </main>
    </>
  );
}
