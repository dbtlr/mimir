import type { EngineTree } from '@mimir/contract';
import { useMemo, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

import { useStartTask } from '../api/node-mutations';
import { needsYouId } from '../api/view-queries';
import type { FrontierTask, ReviewReport, ShippedTask, WorkReport } from '../api/view-queries';
import type { AgentRun } from '../lib/agent-card';
import { useFocusHandoff } from '../lib/focus-main';
import { lastSevenDays } from '../lib/home';
import { nodeLink } from '../lib/record-url';
import {
  lastFinishedAt,
  latestMoveFirst,
  partsOf,
  quietSentence,
  scopeCards,
  scopedMinuteRows,
  shippedSplit,
  upNext,
} from '../lib/scoped-work';
import type { Part, Parts, ShippedBreakdown, UpNext } from '../lib/scoped-work';
import { STATUS_META } from '../lib/status';
import { presetLink } from '../lib/task-list';
import { ago, relativeTime } from '../lib/time';
import { dayOf } from '../lib/work-page';
import { MinuteSection, NowSection, ShippedSection } from './home-sections';
import { settle } from './needs-you-cards';
import { NeedsYouDeck } from './needs-you-deck';
import { needsYouCards } from './needs-you-deck-model';
import type { CardAction } from './patterns/feed/card-actions';
import { FeedCardList } from './patterns/feed/card-list';
import type { ListCard } from './patterns/feed/card-list';
import { FinishedRow } from './patterns/feed/day-fold';
import type { Preview } from './patterns/feed/preview-panel';
import { Quiet } from './patterns/feed/quiet';
import { RowGroup } from './patterns/feed/row-group';
import type { RowGroupRow } from './patterns/feed/row-group';
import { FeedSection } from './patterns/feed/section-head';
import { ListFold } from './patterns/list-page';
import { StatusBadge } from './status-badge';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';
import { AgentNowRow, useRowStop } from './work-sections';

/*
 * A project's, initiative's, or phase's Work tab (ADR 0013, MMR-727
 * refinement): Home's page with the record as its scope. Needs you, Now, Up
 * next, and Shipped this week, each left out when empty, or one quiet sentence
 * in their place when all four are; then When you have a minute and the parts.
 * A link appears only where its destination shows the same set: a project's
 * Now, Shipped, Seeds to triage, Going cold, and Record health; and the rows
 * that open one record's page. Every other row and head is plain.
 */

/** An Up next card's preview: its status, that it can start now, and what it says of itself. */
function upNextPreview(row: FrontierTask): Omit<Preview, 'action'> {
  const { task } = row;
  const text = task.lede ?? task.summary;
  return {
    age: relativeTime(task.updatedAt),
    facts: task.priority == null ? [] : [{ label: 'Priority', value: task.priority }],
    id: task.id,
    lead: <StatusBadge status={task.status} />,
    open: nodeLink(task.id),
    reason: (
      <>
        <b>{STATUS_META[task.status].label}.</b> It can start now. Last moved {ago(task.updatedAt)}.
      </>
    ),
    text: text === null || text === undefined || text === '' ? undefined : text,
    title: task.title,
  };
}

/** The one row for what unlocks next, opening the prerequisite's page. */
function UnlocksRow({ unlocks }: { unlocks: NonNullable<UpNext['unlocks']> }) {
  return (
    <div className="border-y border-line">
      <RowGroup
        label="Unlocks next"
        rows={[
          {
            count: unlocks.count,
            name: `Unlocks when ${unlocks.id} lands`,
            to: nodeLink(unlocks.id),
          },
        ]}
      />
    </div>
  );
}

/**
 * Up next: the tasks that can start now as cards whose one action is Start,
 * three at most, under "N can start", then the one row for what unlocks
 * next. With nothing startable, that row alone keeps the section, under a
 * head with no count.
 */
function UpNextSection({
  next,
  offline,
  quiet,
}: {
  next: UpNext;
  offline: boolean;
  quiet: RefObject<HTMLParagraphElement | null>;
}) {
  if (next.total === 0 && next.unlocks === undefined) {
    return null;
  }
  const unlocks = next.unlocks === undefined ? undefined : <UnlocksRow unlocks={next.unlocks} />;
  if (next.cards.length === 0) {
    return <FeedSection title="Up next">{unlocks}</FeedSection>;
  }
  return <UpNextCards next={next} unlocks={unlocks} offline={offline} quiet={quiet} />;
}

/**
 * Up next's cards that can start, then the unlocks row. The last card to
 * leave hands its focus to the quiet sentence when one replaced the sections,
 * else to the page.
 */
function UpNextCards({
  next,
  unlocks,
  offline,
  quiet,
}: {
  next: UpNext;
  unlocks: ReactNode;
  offline: boolean;
  quiet: RefObject<HTMLParagraphElement | null>;
}) {
  const { mutateAsync: start } = useStartTask();
  const block = useRef<HTMLDivElement>(null);
  useFocusHandoff({ block, to: quiet });
  const byId = new Map(next.cards.map((row) => [row.task.id, row]));
  const cards: ListCard[] = next.cards.map((row) => {
    const action: CardAction = {
      kind: 'write',
      label: 'Start',
      name: `Start ${row.task.id}`,
      run: ({ write }) => {
        void settle(start(row.task.id), write);
      },
    };
    return {
      action,
      card: {
        cold: row.stale,
        id: row.task.id,
        lead: <StatusBadge status={row.task.status} />,
        title: row.task.title,
      },
      key: row.task.id,
      previewKey: row.task.id,
    };
  });
  return (
    // The list draws its own section, the first in the list's box; the 32 between feed sections is set here.
    <div ref={block} className="mt-8 first:mt-0">
      <FeedCardList
        sections={[
          {
            cards,
            count: `${next.total.toLocaleString('en-US')} can start`,
            footer: unlocks === undefined ? undefined : <div className="mt-3">{unlocks}</div>,
            key: 'up-next',
            title: 'Up next',
          },
        ]}
        preview={(key) => {
          const row = byId.get(key);
          return row === undefined ? undefined : upNextPreview(row);
        }}
        quiet="Nothing can start yet."
        offline={offline}
      />
    </div>
  );
}

/** "Today", or the weekday a done task finished on this week. */
function shippedDay(at: Date, zone: string): string {
  const day = dayOf(at.getTime(), zone);
  if (day === lastSevenDays(zone).today) {
    return 'Today';
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(
    Date.parse(`${day}T00:00:00.000Z`),
  );
}

/** A phase's done task as a Shipped row, opening its page. */
function ShippedTaskRow({ row, zone }: { row: ShippedTask; zone: string }) {
  return (
    <FinishedRow
      to={nodeLink(row.task.id)}
      dot={<StatusDot status={row.task.status} />}
      status={STATUS_META[row.task.status].label}
      title={row.task.title}
      time={shippedDay(row.finishedAt, zone)}
    />
  );
}

/** Shipped's counts one level down as plain rows, or a phase's done tasks as rows to their pages. */
function ShippedBreakdownRows({ breakdown, zone }: { breakdown: ShippedBreakdown; zone: string }) {
  if (breakdown.kind === 'tasks') {
    return (
      <ul aria-label="Shipped tasks" className="m-0 list-none divide-y divide-line p-0">
        {breakdown.rows.map((row) => (
          <li key={row.task.id}>
            <ShippedTaskRow row={row} zone={zone} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <RowGroup
      label="Shipped by part"
      rows={breakdown.rows.map(({ id, name, count }) => ({ count, id, name }))}
    />
  );
}

/** A part as a door: its status dot and status in words, its title, and done over total. */
function partRow(part: Part): RowGroupRow {
  return {
    count: part.total,
    id: part.id,
    lead: (
      <>
        <StatusDot status={part.status} />
        <span className="sr-only">{STATUS_META[part.status].label}:</span>
      </>
    ),
    name: part.title,
    shows: {
      kind: 'words',
      text:
        part.total === 0
          ? 'Empty'
          : `${part.done.toLocaleString('en-US')} of ${part.total.toLocaleString('en-US')} done`,
    },
    to: nodeLink(part.id),
  };
}

/**
 * Parts, last: a project's initiatives or an initiative's phases in tree
 * order, each opening its page, with the finished ones gathered in one Lane
 * fold, closed until opened.
 */
function PartsSection({ parts }: { parts: Parts }) {
  const count = parts.open.length + parts.finished.length;
  const fold =
    parts.finished.length === 0 ? undefined : (
      <ListFold label={`Finished ${parts.noun}`} count={parts.finished.length}>
        <RowGroup label={`Finished ${parts.noun}`} rows={parts.finished.map(partRow)} keepZero />
      </ListFold>
    );
  // Named for what the parts are, as the round-6 mock heads them: Initiatives or Phases.
  const title = parts.noun === 'initiatives' ? 'Initiatives' : 'Phases';
  return (
    <FeedSection title={title} count={count}>
      <RowGroup label={title} rows={parts.open.map(partRow)} keepZero framed after={fold} />
    </FeedSection>
  );
}

/**
 * Needs you before the review read lands: a skeleton for the deck while it
 * is pending, or one line once it failed with nothing cached.
 */
function NeedsYouUnread({ failed }: { failed: boolean }) {
  return (
    <FeedSection title="Needs you">
      {failed ? (
        <p className="m-0 text-xs text-status-blocked-foreground">Couldn’t load what needs you.</p>
      ) : (
        <Skeleton aria-busy className="h-20 w-full" />
      )}
    </FeedSection>
  );
}

/** What the Work tab reads besides the work read. */
export type ScopedReads = {
  /** The project tree: the parts, the Shipped split's names, and the last finish. */
  tree: EngineTree | undefined;
  /** The review report: the needs-you cards and the project's untriaged seeds. */
  review: ReviewReport | undefined;
  /** The review read failed with nothing cached. */
  reviewFailed: boolean;
  /** The project's Record health findings. */
  findings: number;
  /** The running agent run in this scope, if any. */
  agentRun: AgentRun | null;
};

export function ScopedWork({
  work,
  projectKey,
  zone,
  offline,
  reads,
}: {
  work: WorkReport;
  projectKey: string;
  zone: string;
  offline: boolean;
  reads: ScopedReads;
}) {
  const { tree, review, reviewFailed, findings, agentRun } = reads;
  const { scope } = work;
  const isProject = scope.kind === 'project';
  const stop = useRowStop(agentRun ?? undefined);
  const needsYou = useMemo(() => work.needsYou.map(needsYouId), [work.needsYou]);
  // Until the review lands, the work read's own needs-you rows say whether the deck will hold any.
  const cards =
    review === undefined ? needsYou.length : scopeCards(needsYouCards(review), needsYou).length;
  const now = latestMoveFirst(work.now);
  const next = upNext(work.frontier);
  const shipped = shippedSplit({ rows: work.shipped, scope, tree, zone });
  const quiet =
    cards === 0 &&
    now.length === 0 &&
    agentRun === null &&
    next.total === 0 &&
    next.unlocks === undefined &&
    shipped.total === 0;
  const untriaged = review?.projects.find((project) => project.key === projectKey)?.untriaged ?? 0;
  const parts = partsOf(tree, scope.id);
  const agent: ReactNode =
    agentRun === null ? undefined : <AgentNowRow run={agentRun} stopButton={stop.button} />;
  // Focus held in a section the quiet sentence replaces goes to that sentence (ADR 0019).
  const busy = useRef<HTMLDivElement>(null);
  const quietLine = useRef<HTMLParagraphElement>(null);
  useFocusHandoff({ block: busy, present: !quiet, to: quietLine });

  return (
    <div className="flex flex-col">
      {quiet ? (
        <Quiet ref={quietLine}>
          {quietSentence({ lastFinished: lastFinishedAt(tree, scope.id), zone })}
        </Quiet>
      ) : (
        <div ref={busy} className="flex flex-col">
          {review === undefined ? (
            <NeedsYouUnread failed={reviewFailed} />
          ) : (
            <NeedsYouDeck
              report={review}
              scope={needsYou}
              quiet="Nothing here needs you."
              offline={offline}
            />
          )}
          <NowSection
            rows={now}
            seeAll={isProject ? presetLink(projectKey, 'in-flight') : undefined}
            agent={agent}
          />
          <UpNextSection next={next} offline={offline} quiet={quietLine} />
          <ShippedSection
            days={shipped.days}
            total={shipped.total}
            breakdown={<ShippedBreakdownRows breakdown={shipped.breakdown} zone={zone} />}
            seeAll={isProject ? presetLink(projectKey, 'shipped-week') : undefined}
          />
        </div>
      )}
      <MinuteSection
        rows={scopedMinuteRows({
          findings,
          kind: scope.kind,
          project: projectKey,
          untriaged,
          work,
        })}
      />
      {parts !== undefined && <PartsSection parts={parts} />}
      {stop.dialog}
    </div>
  );
}
