import { useRef } from 'react';
import type { ReactNode } from 'react';

import type { NowTask } from '../api/view-queries';
import { cn } from '../lib/cn';
import { nowCount, nowShown, statusSince } from '../lib/home';
import type { MinuteDoor, MinuteRow, ShippedWeek } from '../lib/home';
import { nodeLink } from '../lib/record-url';
import { seedShowLink } from '../lib/seed-list';
import { STATUS_META } from '../lib/status';
import { presetLink } from '../lib/task-list';
import { ago, relativeTime } from '../lib/time';
import { useMediaQuery } from '../lib/use-media-query';
import { FeedCard } from './patterns/feed/card';
import { CardGrid } from './patterns/feed/card-grid';
import { FeedPreview } from './patterns/feed/feed-preview';
import type { FeedLink } from './patterns/feed/link';
import type { Preview } from './patterns/feed/preview-panel';
import { RowGroup } from './patterns/feed/row-group';
import { FeedSection } from './patterns/feed/section-head';
import { ShippedSummary } from './patterns/feed/shipped-summary';
import type { ShippedDay } from './patterns/feed/shipped-summary';
import { StatusBadge } from './status-badge';

/*
 * The feed sections Home and a scoped Work tab share (ADR 0013, MMR-722,
 * MMR-724, MMR-725, and MMR-727 refinements): Now as capped title cards, the
 * Shipped week as a summary with its counts one level down, and the
 * spare-minute work as count rows. Each hides when it has nothing to show.
 * The page decides each section's rows and doors: Home's span projects and
 * open a list only when all of their work is one project's; a project's Work
 * tab opens its own lists, and an initiative's or phase's rows stay plain
 * until their lists exist. A row with nowhere to go is a plain row.
 */

/** The width from which Home shows six Now cards rather than four: the deck's and the preview's 768. */
const DESKTOP = '(min-width: 768px)';

/** A Now row; Home's rows name the project each belongs to. */
type NowRow = NowTask & { project?: string };

/** "Started 12m ago.", "Queued 1h ago.", or "Submitted 35m ago.": when the status began. */
function sinceSentence(row: NowRow): string {
  const { status } = row.task;
  let verb = 'Started';
  if (status === 'queued') {
    verb = 'Queued';
  } else if (status === 'under_review' || status === 'staged') {
    verb = 'Submitted';
  }
  return `${verb} ${ago(statusSince(row))}.`;
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
    age: relativeTime(statusSince(row)),
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

/** The project a Now card names: its project's name where the feed spans projects, else none. */
function projectName(row: NowRow, names: ReadonlyMap<string, string> | undefined) {
  return row.project === undefined ? undefined : names?.get(row.project);
}

/**
 * Now: title cards for the tasks in flight, in the order given (most recent
 * move first: the latest submit, else the start), four on a phone and six
 * from 768. The head counts what shows of the whole ("6 of 9") when the cap
 * hides cards. A card opens its preview, as the deck's do. `names` names each
 * card's project where the feed spans projects (Home). `agent` is a running
 * agent's row, above the cards while the run is live (a scoped page, MMR-727):
 * it keeps the section shown, and the head's count leaves it out.
 */
export function NowSection({
  rows,
  names,
  seeAll,
  agent,
}: {
  rows: readonly NowRow[];
  names?: ReadonlyMap<string, string>;
  seeAll?: FeedLink;
  agent?: ReactNode;
}) {
  const desktop = useMediaQuery(DESKTOP);
  const body = useRef<HTMLDivElement>(null);
  if (rows.length === 0 && agent === undefined) {
    return null;
  }
  const shown = rows.slice(0, nowShown(rows.length, { desktop }));
  const byId = new Map(shown.map((row) => [row.task.id, row]));
  return (
    <FeedSection
      title="Now"
      count={rows.length === 0 ? undefined : nowCount(rows.length, { desktop })}
      seeAll={seeAll}
    >
      {agent !== undefined && <div className={cn(rows.length > 0 && 'mb-3')}>{agent}</div>}
      <FeedPreview
        // When a refetch or a narrower cap drops the card that opened the preview, focus a shown card.
        fallbackFocus={() =>
          body.current?.querySelector<HTMLElement>('[data-slot="feed-card-target"]') ?? null
        }
        preview={(key) => {
          const row = byId.get(key);
          return row === undefined ? undefined : nowPreview(row, projectName(row, names));
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
                project={projectName(row, names)}
                age={relativeTime(statusSince(row))}
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
 * Shipped this week: the seven-day chart, then `breakdown`, the counts one
 * level down (Home's by project, a scoped page's by phase or initiative) or a
 * phase's done tasks. Hidden when nothing shipped in the window.
 */
export function ShippedSection({
  days,
  total,
  breakdown,
  seeAll,
}: {
  days: readonly ShippedDay[];
  /** The week's done tasks, the head's count. */
  total: number;
  breakdown: ReactNode;
  seeAll?: FeedLink;
}) {
  if (total === 0) {
    return null;
  }
  return (
    <FeedSection title="Shipped this week" count={total} seeAll={seeAll}>
      <ShippedSummary days={days} breakdown={breakdown} />
    </FeedSection>
  );
}

/** Home's Shipped counts one level down: by project, each a door to that project's week. */
export function ShippedByProject({ week }: { week: ShippedWeek }) {
  return (
    <RowGroup
      label="Shipped by project"
      rows={week.byProject.map(({ key, name, count }) => ({
        count,
        key,
        name,
        to: presetLink(key, 'shipped-week'),
      }))}
    />
  );
}

/** A spare-minute row's door as a link: a Tasks preset, a Seeds view, or a project's Record health. */
function doorLink(door: MinuteDoor): FeedLink {
  switch (door.list) {
    case 'tasks': {
      return presetLink(door.project, door.show);
    }
    case 'seeds': {
      return seedShowLink(door.project, door.show);
    }
    case 'doctor': {
      return { search: { project: door.project }, to: '/doctor' };
    }
    default: {
      const _exhaustive: never = door;
      return _exhaustive;
    }
  }
}

/**
 * When you have a minute: what can wait, as count rows in a frame matching
 * Shipped's card. A row at zero is left out, and the section with it when
 * every row is zero.
 */
export function MinuteSection({ rows }: { rows: readonly MinuteRow[] }) {
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
