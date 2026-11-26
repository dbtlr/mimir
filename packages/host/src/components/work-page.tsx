import type { EngineNode, EngineTree, NodeRef } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { agentActivityQuery } from '../api/agent-queries';
import { HostFaultError, isEngineRefusal } from '../api/errors';
import type { DirectionTarget } from '../api/node-mutations';
import { browserTimeZone } from '../api/queries';
import { phaseDeliveriesQuery, workQuery } from '../api/view-queries';
import { scopedRun } from '../lib/agent-card';
import { kindName, splitKindTags } from '../lib/artifacts';
import { cn } from '../lib/cn';
import { foldByDay } from '../lib/day-folds';
import { PAGE_COLUMN } from '../lib/page-column';
import { projectKeyOf } from '../lib/project-key';
import { artifactLink, nodeLink } from '../lib/record-url';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { newestArtifacts, shippedTime } from '../lib/work-page';
import type { RecordArtifact } from '../lib/work-page';
import { PhaseDeliveries } from './delivery-summary';
import { DirectionDialog } from './direction-line';
import { DistributionBar } from './distribution-bar';
import { MarkdownBody } from './markdown-body';
import { NewTaskButton } from './new-task-button';
import { SignalBadges, hasSignals, prerequisiteRows } from './node-record';
import type { ActionMenuAction } from './patterns/action-menu';
import { Fact, Facts } from './patterns/facts';
import { DayFolds, FinishedRow } from './patterns/feed/day-fold';
import { FEED_FOCUS_RING } from './patterns/feed/link';
import { RowGroup } from './patterns/feed/row-group';
import { RecordHeader } from './patterns/record-header';
import { RecordTabs } from './patterns/record-tabs';
import type { RecordTab } from './patterns/record-tabs';
import { ProjectSettings } from './project-settings';
import { RECORD_TYPE_LABEL, RecordMore, moreEntries, recordTrail } from './record-head';
import { StatusBadge, StatusWord } from './status-badge';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';
import { WorkSections } from './work-sections';

/*
 * The work page (ADR 0013, MMR-467, MMR-492, and MMR-726 refinements): a
 * project, initiative, or phase opens under the record header with its tabs.
 * Work, first, holds the progress bar, a project's Record health, and the five
 * question-ordered sections; Details holds the Direction, the description,
 * what the record depends on and blocks, and its dates. An initiative or phase
 * adds Timeline and Artifacts; a project's other tabs are its browsers. A tab
 * with nothing in it is hidden. The project's structure lives in the shell's
 * sidebar outline.
 */

/** `11 done · 2 parked · 1 in progress` — the rollup's counts, in the status system's order. */
function distributionLegend(distribution: NonNullable<EngineNode['distribution']>): string {
  return (
    STATUS_ORDER.filter((word) => (distribution[word] ?? 0) > 0)
      // A non-breaking space keeps each count with its word when the legend wraps.
      .map((word) => `${String(distribution[word])}\u00a0${STATUS_META[word].label.toLowerCase()}`)
      .join(' · ')
  );
}

/** How many tasks the record's rollup counts. */
export function taskCount(record: EngineNode): number {
  return Object.values(record.distribution ?? {}).reduce((sum, count) => sum + count, 0);
}

/** The record's own column: one centred column of at most 900px, no rail (MMR-726). */
export function RecordColumn({ offline, children }: { offline: boolean; children: ReactNode }) {
  return (
    // tabIndex -1: a focus fallback for a control that unmounts itself, such
    // as a row's button once its action moves the row out of the list.
    <main
      tabIndex={-1}
      data-testid="record-scroll"
      className={cn('min-h-0 w-full flex-1 overflow-y-auto', offline && 'offline-demoted')}
    >
      <div className={cn(PAGE_COLUMN, 'px-3.5 pt-4 pb-10 md:px-5 md:pt-6')}>{children}</div>
    </main>
  );
}

/**
 * A project's, initiative's, or phase's header: its trail, status, type, and
 * summary, New task as its main action, and More with what else it offers.
 * A project has no summary of its own, so its description stands in for one.
 */
export function ContainerHead({
  record,
  tree,
  offline,
}: {
  record: EngineNode;
  tree?: EngineTree;
  offline: boolean;
}) {
  const isProject = record.type === 'project';
  const projectKey = projectKeyOf(record.id);
  const [editing, setEditing] = useState<'project' | 'direction' | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const subject: DirectionTarget = isProject
    ? { key: record.id, kind: 'project' }
    : { id: record.id, kind: 'node' };
  const edit: ActionMenuAction[] = [
    ...(isProject
      ? [
          {
            disabled: offline,
            key: 'edit',
            kind: 'action' as const,
            label: 'Edit',
            onSelect: () => {
              setEditing('project');
            },
          },
        ]
      : []),
    {
      disabled: offline,
      key: 'direction',
      kind: 'action',
      label: 'Edit direction…',
      onSelect: () => {
        setEditing('direction');
      },
    },
  ];
  return (
    <>
      <RecordHeader
        trail={isProject ? [] : recordTrail(projectKey, tree, record.id)}
        title={record.title}
        status={<StatusBadge status={record.status} />}
        type={RECORD_TYPE_LABEL[isProject ? 'project' : record.type]}
        recordId={record.id}
        summary={isProject ? record.description : record.summary}
        actions={
          <>
            <NewTaskButton
              main
              projectKey={projectKey}
              offline={offline}
              home={isProject ? undefined : record.id}
            />
            <RecordMore
              title={record.title}
              recordId={record.id}
              entries={moreEntries([edit])}
              triggerRef={more}
            />
          </>
        }
      />
      {isProject && (
        <ProjectSettings
          project={record}
          offline={offline}
          open={editing === 'project'}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {editing === 'direction' && (
        <DirectionDialog
          subject={subject}
          title={record.title}
          next={record.next}
          open
          finalFocus={() => more.current}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The Work tab's body: the sections, a skeleton while the read is pending, or the failure. */
function WorkBody({
  record,
  projectKey,
  isProject,
  offline,
  tree,
}: {
  record: EngineNode;
  projectKey: string;
  isProject: boolean;
  offline: boolean;
  tree?: EngineTree;
}) {
  const work = useQuery(
    workQuery(
      isProject ? { key: record.id, kind: 'project' } : { id: record.id, kind: 'container' },
    ),
  );
  const activity = useQuery(agentActivityQuery);
  if (work.data === undefined) {
    return work.isError ? (
      <p className="text-xs text-status-blocked-foreground">
        {/* An answered failure (an Engine refusal or a host fault) says no more than that; only a request that never got an answer asks about the server. */}
        {isEngineRefusal(work.error) || work.error instanceof HostFaultError
          ? 'Couldn’t load the work page.'
          : 'Couldn’t load the work page, and nothing is cached yet — is the Mimir host running?'}
      </p>
    ) : (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  return (
    <>
      {record.type === 'phase' && <PhaseDeliveries id={record.id} />}
      <WorkSections
        report={work.data}
        projectKey={projectKey}
        home={isProject ? undefined : record.id}
        zone={browserTimeZone()}
        offline={offline}
        agentRun={scopedRun(
          activity.data,
          projectKey,
          isProject ? undefined : { id: record.id, tree },
        )}
      />
    </>
  );
}

/**
 * The Work tab: the rollup's progress bar and legend, a project's Record
 * health findings as a row to the doctor panel, then the work sections.
 */
export function WorkTab({
  record,
  tree,
  findings = 0,
  offline,
}: {
  record: EngineNode;
  tree?: EngineTree;
  findings?: number;
  offline: boolean;
}) {
  const isProject = record.type === 'project';
  const projectKey = projectKeyOf(record.id);
  const legend = record.distribution === undefined ? '' : distributionLegend(record.distribution);
  const health = isProject && findings > 0;
  return (
    <div className="flex flex-col">
      {record.distribution !== undefined && taskCount(record) > 0 && (
        <div className="mb-3">
          <DistributionBar distribution={record.distribution} className="h-1.5 w-full" />
          {legend !== '' && <p className="mt-2 text-meta text-ink-dim">{legend}</p>}
        </div>
      )}
      {health && (
        <div className="border-y border-line">
          <RowGroup
            label="Record health"
            rows={[
              {
                count: findings,
                name: 'Record health',
                to: { search: { project: projectKey }, to: '/doctor' },
              },
            ]}
          />
        </div>
      )}
      {/* Each section's own 16 top margin (Live deliveries' too), after the legend's 12, sets the first 28 below it. */}
      <div className={cn(health && 'mt-8')}>
        <WorkBody
          record={record}
          projectKey={projectKey}
          isProject={isProject}
          offline={offline}
          tree={tree}
        />
      </div>
    </div>
  );
}

/**
 * One titled part of a record's tab, divided from the next by a hairline, as
 * Details' sections are. `ruled={false}` leaves out the hairline and its
 * padding, for sections the caller spaces itself (a task's Depends on and
 * Blocks on Work).
 */
export function DetailsSection({
  title,
  count,
  ruled = true,
  children,
}: {
  title: string;
  count?: number;
  ruled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(ruled && 'border-b border-line py-6 first:pt-0 last:border-b-0 last:pb-0')}
    >
      {/* A flex row, so the gap before the count is 8 and the space only keeps the name readable. */}
      <h2
        id={id}
        className="mb-2 flex items-baseline gap-2 text-base font-semibold text-ink-bright"
      >
        {title}{' '}
        {count !== undefined && <span className="text-meta font-normal text-ink-dim">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/**
 * A link to a related record: its ID in mono at the line's size, its title,
 * then its status at the right in the header's idiom, the dot right before a
 * bright word. Its hairline above runs straight to the column's edges.
 *
 * `stacked` is a task's form on Work (MMR-728): the status dot in a 16
 * column, the title in `text-title` `ink-bright` (two lines at most on a
 * phone, one from `md`), and under it the ID in mono and the status word,
 * 8 apart around a "·".
 */
export function RelationRow({ refNode, stacked = false }: { refNode: NodeRef; stacked?: boolean }) {
  if (stacked) {
    return (
      <Link
        {...nodeLink(refNode.id)}
        className={cn(
          'grid min-h-11 grid-cols-[16px_minmax(0,1fr)] gap-x-2 border-t border-line py-[11px] transition-colors hover:bg-well-800 md:min-h-9 md:py-[7px]',
          FEED_FOCUS_RING,
        )}
      >
        <span aria-hidden className="flex justify-center pt-2">
          {refNode.status !== undefined && <StatusDot status={refNode.status} />}
        </span>
        <span className="min-w-0">
          <span className="block text-title font-medium text-ink-bright line-clamp-2 wrap-anywhere md:line-clamp-1">
            {refNode.title ?? refNode.id}
          </span>{' '}
          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-meta text-ink-dim">
            <span className="font-mono">{refNode.id}</span>
            {refNode.status !== undefined && (
              <>
                <span aria-hidden>·</span>
                <StatusWord>{STATUS_META[refNode.status].label}</StatusWord>
              </>
            )}
          </span>
        </span>
      </Link>
    );
  }
  return (
    <Link
      {...nodeLink(refNode.id)}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-2 border-t border-line text-label text-ink transition-colors hover:bg-well-800 md:min-h-9',
        FEED_FOCUS_RING,
      )}
    >
      <span className="shrink-0 font-mono text-ink-dim [font-size-adjust:var(--mono-adjust)]">
        {refNode.id}
      </span>{' '}
      <span className="min-w-0 flex-1 truncate">{refNode.title ?? ''}</span>{' '}
      {refNode.status !== undefined && (
        <StatusBadge status={refNode.status} className="shrink-0 pl-2" />
      )}
    </Link>
  );
}

/**
 * The Details tab: the Direction, in full (More's Edit direction… rewrites
 * it); the description, in full (a project's also stands in for the summary its header clamps); what
 * it depends on and blocks; its signals; and its dates.
 */
export function ContainerDetails({ record }: { record: EngineNode }) {
  const direction = record.next?.trim() ?? '';
  const description = record.description?.trim() ?? '';
  const prerequisites = record.deps === undefined ? [] : prerequisiteRows(record.deps);
  const blocking = record.deps?.blocking ?? [];
  return (
    <div className="flex flex-col">
      <DetailsSection title="Direction">
        {direction === '' ? (
          <p className="text-body text-ink">No direction set.</p>
        ) : (
          <MarkdownBody className="max-w-[70ch]">{direction}</MarkdownBody>
        )}
      </DetailsSection>
      {description !== '' && (
        <DetailsSection title="Description">
          <MarkdownBody breaks className="max-w-[70ch]">
            {description}
          </MarkdownBody>
        </DetailsSection>
      )}
      {prerequisites.length > 0 && (
        <DetailsSection title="Depends on" count={prerequisites.length}>
          <div>
            {prerequisites.map((r) => (
              <RelationRow key={r.id} refNode={r} />
            ))}
          </div>
        </DetailsSection>
      )}
      {blocking.length > 0 && (
        <DetailsSection title="Blocking" count={blocking.length}>
          <div>
            {blocking.map((r) => (
              <RelationRow key={r.id} refNode={r} />
            ))}
          </div>
        </DetailsSection>
      )}
      <section aria-label="Facts" className="py-6 last:pb-0">
        {hasSignals(record) && (
          <div className="mb-4">
            <SignalBadges node={record} />
          </div>
        )}
        <Facts>
          <Fact label="Created">{absoluteTime(record.createdAt)}</Fact>
          <Fact label="Updated">{absoluteTime(record.updatedAt)}</Fact>
          {record.target != null && <Fact label="Target">{record.target}</Fact>}
        </Facts>
      </section>
    </div>
  );
}

/** One attached artifact as the Artifacts list's row; every one is on this record, so its second line names only its kind. */
function artifactRow(artifact: RecordArtifact, zone: string) {
  const { kind } = splitKindTags(artifact.tags);
  return (
    <FinishedRow
      key={artifact.id}
      variant="artifact"
      to={artifactLink(artifact.id)}
      title={artifact.title}
      meta={kind === undefined ? undefined : <span className="text-ink">{kindName(kind)}</span>}
      time={shippedTime(artifact.createdAt, zone)}
    />
  );
}

/** A record page's Artifacts tab: what is attached, newest first, folded by the day it was frozen. */
export function ArtifactsTab({ record }: { record: EngineNode }) {
  const zone = browserTimeZone();
  const artifacts = record.artifacts ?? [];
  const days = foldByDay(newestArtifacts(artifacts, artifacts.length), {
    at: (artifact) => artifact.createdAt,
    row: (artifact) => artifactRow(artifact, zone),
    zone,
  });
  return <DayFolds days={days} cap={Number.POSITIVE_INFINITY} />;
}

/** The tabs of an initiative, a phase, or a task, in their order. */
export type RecordPageTab = 'work' | 'details' | 'timeline' | 'artifacts';

/** Open `tab`; `replace` swaps the URL's entry rather than pushing one. */
export type OpenTab = (tab: RecordPageTab, options?: { replace: boolean }) => void;

/** What the page adds to a record's tabs: the selected one, and the Timeline. */
export type RecordPageTabs = {
  tab: RecordPageTab | undefined;
  onTab: OpenTab;
  /** The Timeline tab's body — the record's timeline. */
  timeline: ReactNode;
  timelineCount: number;
  /**
   * When the record's page mounted, and when its record was last read: a read
   * from before then may be a cached one that predates what fills a tab.
   */
  since: number;
  recordReadAt: number;
};

/**
 * The tabs a record page shows, in order, hidden when empty: Work when
 * `work` says it holds something, Details and Timeline always (a record
 * always has its dates and its creation), Artifacts once one is attached.
 */
export function recordTabs(record: EngineNode, timelineCount: number, work: boolean) {
  const artifacts = record.artifacts?.length ?? 0;
  const tabs: RecordTab<RecordPageTab>[] = [
    ...(work ? [{ label: 'Work', value: 'work' as const }] : []),
    { label: 'Details', value: 'details' },
    { count: timelineCount, label: 'Timeline', value: 'timeline' },
    ...(artifacts > 0
      ? [{ count: artifacts, label: 'Artifacts', value: 'artifacts' as const }]
      : []),
  ];
  return tabs;
}

/**
 * An initiative's or phase's tabs: Work once it holds tasks or
 * `liveDeliveries` (a delivery may name no tasks).
 */
export function containerTabs(record: EngineNode, timelineCount: number, liveDeliveries: boolean) {
  return recordTabs(record, timelineCount, taskCount(record) > 0 || liveDeliveries);
}

/**
 * The tab a record page shows. The URL names it (`asked`; none is Work); when
 * that one is hidden, the page shows the first tab that has something in it
 * and, once `current` (the reads that decide the tabs are from since the page
 * mounted), replaces the URL with it, so the page stays on it when the hidden
 * one fills, and it reads as chosen.
 */
export function useShownTab(
  tabs: readonly RecordTab<RecordPageTab>[],
  asked: RecordPageTab | undefined,
  current: boolean,
  onTab: OpenTab,
): RecordPageTab {
  const wanted = asked ?? 'work';
  const tab = tabs.find((t) => t.value === wanted)?.value ?? tabs[0]?.value ?? 'details';
  const settle = useEffectEvent(() => {
    onTab(tab, { replace: true });
  });
  useEffect(() => {
    if (tab !== wanted && current) {
      settle();
    }
  }, [tab, wanted, current]);
  return tab;
}

/**
 * An initiative's or phase's page: its header, then its tabs, the shown one
 * as `useShownTab` picks it.
 */
export function ContainerPage({
  record,
  tree,
  offline,
  container,
}: {
  record: EngineNode;
  tree?: EngineTree;
  offline: boolean;
  container: RecordPageTabs;
}) {
  // The read Work's Live deliveries makes, here only while it decides whether
  // a phase with no tasks has Work; until it answers none, Work may hold them.
  const deliveriesDecideWork = record.type === 'phase' && taskCount(record) === 0;
  const deliveries = useQuery({
    ...phaseDeliveriesQuery(record.id),
    enabled: deliveriesDecideWork,
  });
  const live = record.type === 'phase' && deliveries.data?.length !== 0;
  const tabs = containerTabs(record, container.timelineCount, live);
  const tab = useShownTab(
    tabs,
    container.tab,
    container.recordReadAt >= container.since &&
      (!deliveriesDecideWork || deliveries.dataUpdatedAt >= container.since),
    container.onTab,
  );
  return (
    <RecordColumn offline={offline}>
      <ContainerHead record={record} tree={tree} offline={offline} />
      <RecordTabs
        tabs={tabs}
        value={tab}
        onSelect={(next) => {
          container.onTab(next);
        }}
      >
        {tab === 'work' && <WorkTab record={record} tree={tree} offline={offline} />}
        {tab === 'details' && <ContainerDetails record={record} />}
        {tab === 'timeline' && container.timeline}
        {tab === 'artifacts' && <ArtifactsTab record={record} />}
      </RecordTabs>
    </RecordColumn>
  );
}
