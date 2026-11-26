import type { EngineNode, EngineTree, NodeRef } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { agentActivityQuery } from '../api/agent-queries';
import { HostFaultError, isEngineRefusal } from '../api/errors';
import type { DirectionTarget } from '../api/node-mutations';
import { browserTimeZone } from '../api/queries';
import { treeQuery } from '../api/shell-queries';
import { phaseDeliveriesQuery, reviewQuery, workQuery } from '../api/view-queries';
import { scopedRun } from '../lib/agent-card';
import { kindName, splitKindTags } from '../lib/artifacts';
import { cn } from '../lib/cn';
import { foldByDay } from '../lib/day-folds';
import { PAGE_COLUMN } from '../lib/page-column';
import { projectKeyOf } from '../lib/project-key';
import { artifactLink, nodeLink } from '../lib/record-url';
import { containerHasWork } from '../lib/scoped-work';
import { STATUS_META } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { newestArtifacts, shippedTime } from '../lib/work-page';
import type { RecordArtifact } from '../lib/work-page';
import { PhaseDeliveries } from './delivery-summary';
import { DirectionDialog } from './direction-line';
import { MarkdownBody } from './markdown-body';
import { NewTaskButton } from './new-task-button';
import { SignalBadges, hasSignals, prerequisiteRows } from './node-record';
import type { ActionMenuAction } from './patterns/action-menu';
import { Fact, Facts } from './patterns/facts';
import { DayFolds, FinishedRow } from './patterns/feed/day-fold';
import { FEED_FOCUS_RING } from './patterns/feed/link';
import { RecordHeader } from './patterns/record-header';
import { RecordTabs } from './patterns/record-tabs';
import type { RecordTab } from './patterns/record-tabs';
import { ProjectSettings } from './project-settings';
import { RECORD_TYPE_LABEL, RecordMore, moreEntries, recordTrail } from './record-head';
import { ScopedWork } from './scoped-work';
import { StatusBadge, StatusWord } from './status-badge';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';

/*
 * The work page (ADR 0013, MMR-467, MMR-492, MMR-726, and MMR-727
 * refinements): a project, initiative, or phase opens under the record header
 * with its tabs. Work, first, is Home's page with the record as its scope
 * (scoped-work.tsx); Details holds the Direction, the description, what the
 * record depends on and blocks, and its dates. An initiative or phase adds
 * Timeline and Artifacts, and a phase Deliveries; a project's other tabs are
 * its browsers. A tab with nothing in it is hidden. The project's structure
 * lives in the shell's sidebar outline.
 */

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

/** The Work tab's body: the scoped sections, a skeleton while the work read is pending, or the failure. */
function WorkBody({
  record,
  projectKey,
  isProject,
  offline,
  findings,
}: {
  record: EngineNode;
  projectKey: string;
  isProject: boolean;
  offline: boolean;
  findings: number;
}) {
  const work = useQuery(
    workQuery(
      isProject ? { key: record.id, kind: 'project' } : { id: record.id, kind: 'container' },
    ),
  );
  // The tree names the parts and the Shipped split's containers; the node page
  // reads the same entry. It is the whole board, so it is read once, not polled.
  const tree = useQuery({ ...treeQuery(projectKey), refetchInterval: false });
  const review = useQuery(reviewQuery());
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
    <ScopedWork
      work={work.data}
      projectKey={projectKey}
      zone={browserTimeZone()}
      offline={offline}
      reads={{
        agentRun: scopedRun(
          activity.data,
          projectKey,
          isProject ? undefined : { id: record.id, tree: tree.data },
        ),
        findings,
        review: review.data,
        tree: tree.data,
      }}
    />
  );
}

/**
 * The Work tab (ADR 0013, MMR-727 refinement): Home's page with the record as
 * its scope. A project's Record health findings are one of its spare-minute
 * rows.
 */
export function WorkTab({
  record,
  findings = 0,
  offline,
}: {
  record: EngineNode;
  findings?: number;
  offline: boolean;
}) {
  const isProject = record.type === 'project';
  return (
    <WorkBody
      record={record}
      projectKey={projectKeyOf(record.id)}
      isProject={isProject}
      offline={offline}
      findings={isProject ? findings : 0}
    />
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
      meta={
        // A long kind truncates within the row, as the records list beside a kind does elsewhere.
        kind === undefined ? undefined : (
          <span className="min-w-0 truncate text-ink">{kindName(kind)}</span>
        )
      }
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

/** The tabs of an initiative, a phase, or a task, in their order; only a phase has Deliveries. */
export type RecordPageTab = 'work' | 'deliveries' | 'details' | 'timeline' | 'artifacts';

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
 * `work` says it holds something, Deliveries when a phase has `deliveries`,
 * Details and Timeline always (a record always has its dates and its
 * creation), Artifacts once one is attached.
 */
export function recordTabs(
  record: EngineNode,
  timelineCount: number,
  work: boolean,
  deliveries = 0,
) {
  const artifacts = record.artifacts?.length ?? 0;
  const tabs: RecordTab<RecordPageTab>[] = [
    ...(work ? [{ label: 'Work', value: 'work' as const }] : []),
    ...(deliveries > 0
      ? [{ count: deliveries, label: 'Deliveries', value: 'deliveries' as const }]
      : []),
    { label: 'Details', value: 'details' },
    { count: timelineCount, label: 'Timeline', value: 'timeline' },
    ...(artifacts > 0
      ? [{ count: artifacts, label: 'Artifacts', value: 'artifacts' as const }]
      : []),
  ];
  return tabs;
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
 * as `useShownTab` picks it. Work shows while a task is under it or it has
 * parts (ADR 0013, MMR-727 refinement); a phase's Deliveries while it has a
 * live delivery. The URL settles on a shown tab only once the reads that
 * decide the tabs are current: the record, a phase's deliveries, and, for a
 * record whose rollup counts no task, the tree that holds its parts.
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
  const phase = record.type === 'phase';
  const deliveries = useQuery({ ...phaseDeliveriesQuery(record.id), enabled: phase });
  const work = containerHasWork(record, tree);
  const tabs = recordTabs(record, container.timelineCount, work, deliveries.data?.length ?? 0);
  const tab = useShownTab(
    tabs,
    container.tab,
    container.recordReadAt >= container.since &&
      (!phase || deliveries.dataUpdatedAt >= container.since) &&
      (work || tree !== undefined),
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
        {tab === 'work' && <WorkTab record={record} offline={offline} />}
        {tab === 'deliveries' && <PhaseDeliveries id={record.id} />}
        {tab === 'details' && <ContainerDetails record={record} />}
        {tab === 'timeline' && container.timeline}
        {tab === 'artifacts' && <ArtifactsTab record={record} />}
      </RecordTabs>
    </RecordColumn>
  );
}
