import { useRef } from 'react';

import type { ReviewReport } from '../api/view-queries';
import { minuteRows, nowCount, nowShown, oneProject } from '../lib/home';
import type { MinuteDoor, ShippedWeek } from '../lib/home';
import { nodeLink } from '../lib/record-url';
import { seedShowLink } from '../lib/seed-list';
import { STATUS_META } from '../lib/status';
import { presetLink } from '../lib/task-list';
import { ago, relativeTime } from '../lib/time';
import { useMediaQuery } from '../lib/use-media-query';
import { FeedCard } from './patterns/feed/card';
import { CardGrid } from './patterns/feed/card-grid';
import { FeedPreview } from './patterns/feed/feed-preview';
import type { Preview } from './patterns/feed/preview-panel';
import { RowGroup } from './patterns/feed/row-group';
import { FeedSection } from './patterns/feed/section-head';
import { ShippedSummary } from './patterns/feed/shipped-summary';
import { StatusBadge } from './status-badge';

/*
 * Home's sections below Needs you (ADR 0013, MMR-722, MMR-724, and MMR-725 refinements):
 * Now as capped title cards, the Shipped week as a summary by project, and the
 * spare-minute work as count rows. Each hides when it has nothing to show;
 * the page's summary sentence says so once. The Tasks and Seeds lists are per
 * project, so the doors into them are too: each project's Shipped row opens
 * its finished week, and Now, Seeds to triage, Ready to start, and Going cold
 * open their list only when all of their work is one project's. Otherwise they keep their count with no
 * link, and a row with nowhere to go is a plain row.
 */

/** The width from which Home shows six Now cards rather than four: the deck's and the preview's 768. */
const DESKTOP = '(min-width: 768px)';

type NowRow = ReviewReport['now'][number];

/** When the card's status began: a review's or a stage's submit, else the start. */
function since(row: NowRow): Date | string {
  const submitted = row.task.status === 'under_review' || row.task.status === 'staged';
  return submitted ? (row.submittedAt ?? row.startedAt) : row.startedAt;
}

/** "Started 12m ago.", "Queued 1h ago.", or "Submitted 35m ago.": when the status began. */
function sinceSentence(row: NowRow): string {
  const { status } = row.task;
  let verb = 'Started';
  if (status === 'queued') {
    verb = 'Queued';
  } else if (status === 'under_review' || status === 'staged') {
    verb = 'Submitted';
  }
  return `${verb} ${ago(since(row))}.`;
}

/** A Now card's preview: its status and when it began, and where its agent works. */
function nowPreview(row: NowRow, project: string | undefined): Preview {
  const { task } = row;
  const facts = [
    ...(task.harness == null ? [] : [{ label: 'Harness', value: task.harness }]),
    ...(task.branch == null
      ? []
      : [{ label: 'Branch', value: <span className="font-mono">{task.branch}</span> }]),
  ];
  return {
    age: relativeTime(since(row)),
    facts,
    id: task.id,
    lead: <StatusBadge status={task.status} />,
    open: nodeLink(task.id),
    project,
    reason: (
      <>
        <b>{STATUS_META[task.status].label}.</b> {sinceSentence(row)}
      </>
    ),
    title: task.title,
  };
}

/**
 * Now: title cards for the tasks in flight, most recent move first (the
 * report's order: the latest submit, else the start), four on a phone and six
 * from 768. The head counts what shows of the whole ("6
 * of 9") when the cap hides cards. A card opens its preview, as the deck's do.
 */
export function NowSection({ report }: { report: ReviewReport }) {
  const desktop = useMediaQuery(DESKTOP);
  const body = useRef<HTMLDivElement>(null);
  const rows = report.now;
  if (rows.length === 0) {
    return null;
  }
  const names = new Map(report.projects.map((project) => [project.key, project.name]));
  const shown = rows.slice(0, nowShown(rows.length, { desktop }));
  const byId = new Map(shown.map((row) => [row.task.id, row]));
  const project = oneProject(rows.map((row) => row.project));
  return (
    <FeedSection
      title="Now"
      count={nowCount(rows.length, { desktop })}
      seeAll={project === undefined ? undefined : presetLink(project, 'in-flight')}
    >
      <FeedPreview
        // When a refetch or a narrower cap drops the card that opened the preview, focus a shown card.
        fallbackFocus={() =>
          body.current?.querySelector<HTMLElement>('[data-slot="feed-card-target"]') ?? null
        }
        preview={(key) => {
          const row = byId.get(key);
          return row === undefined ? undefined : nowPreview(row, names.get(row.project));
        }}
      >
        <div ref={body}>
          <CardGrid>
            {shown.map((row) => (
              <FeedCard
                key={row.task.id}
                previewKey={row.task.id}
                lead={<StatusBadge status={row.task.status} />}
                id={row.task.id}
                project={names.get(row.project)}
                age={relativeTime(since(row))}
                title={row.task.title}
                cold={row.stale}
              />
            ))}
          </CardGrid>
        </div>
      </FeedPreview>
    </FeedSection>
  );
}

/**
 * Shipped this week: the seven-day chart, then the counts by project as plain
 * rows. Hidden when nothing shipped in the window.
 */
export function ShippedSection({ week }: { week: ShippedWeek }) {
  if (week.total === 0) {
    return null;
  }
  return (
    <FeedSection title="Shipped this week" count={week.total}>
      <ShippedSummary
        days={week.days}
        breakdown={
          <RowGroup
            label="Shipped by project"
            rows={week.byProject.map(({ key, name, count }) => ({
              count,
              key,
              name,
              to: presetLink(key, 'shipped-week'),
            }))}
          />
        }
      />
    </FeedSection>
  );
}

/** A spare-minute row's door as a link: a Tasks preset or a Seeds view. */
function doorLink(door: MinuteDoor) {
  return door.list === 'tasks'
    ? presetLink(door.project, door.show)
    : seedShowLink(door.project, door.show);
}

/**
 * When you have a minute: what can wait, as count rows in a frame matching
 * Shipped's card. A row at zero is left out, and the section with it when
 * every row is zero.
 */
export function MinuteSection({ report }: { report: ReviewReport }) {
  const rows = minuteRows(report);
  if (rows.every((row) => row.count === 0)) {
    return null;
  }
  return (
    <FeedSection title="When you have a minute">
      <RowGroup
        label="When you have a minute"
        rows={rows.map(({ name, count, door }) => ({
          count,
          name,
          to: door === undefined ? undefined : doorLink(door),
        }))}
        framed
      />
    </FeedSection>
  );
}
