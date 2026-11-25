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
import { cn } from '../lib/cn';
import { PAGE_COLUMN } from '../lib/page-column';
import { projectKeyOf } from '../lib/project-key';
import { nodeLink } from '../lib/record-url';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { newestArtifacts } from '../lib/work-page';
import { PhaseDeliveries } from './delivery-summary';
import { DirectionDialog } from './direction-line';
import { DistributionBar } from './distribution-bar';
import { MarkdownBody } from './markdown-body';
import { NewTaskButton } from './new-task-button';
import { ArtifactLinks, SignalBadges, hasSignals, prerequisiteRows } from './node-record';
import type { ActionMenuAction } from './patterns/action-menu';
import { FEED_FOCUS_RING } from './patterns/feed/link';
import { RowGroup } from './patterns/feed/row-group';
import { RecordHeader } from './patterns/record-header';
import { RecordTabs } from './patterns/record-tabs';
import type { RecordTab } from './patterns/record-tabs';
import { ProjectSettings } from './project-settings';
import { RECORD_TYPE_LABEL, RecordMore, moreEntries, recordTrail } from './record-head';
import { StatusBadge } from './status-badge';
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

/** One titled part of the Details tab, divided from the next by a hairline. */
function DetailsSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="border-b border-line py-6 first:pt-0 last:border-b-0 last:pb-0"
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
 */
function RelationRow({ refNode }: { refNode: NodeRef }) {
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-meta text-ink-dim">{label}</dt>
      <dd className="m-0 min-w-0 text-label text-ink-bright">{children}</dd>
    </>
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
          <p className="text-body leading-[1.65] text-ink">No direction set.</p>
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
        <dl className="m-0 grid grid-cols-[104px_minmax(0,1fr)] gap-x-4 gap-y-3.5">
          <Fact label="Created">{absoluteTime(record.createdAt)}</Fact>
          <Fact label="Updated">{absoluteTime(record.updatedAt)}</Fact>
          {record.target != null && <Fact label="Target">{record.target}</Fact>}
        </dl>
      </section>
    </div>
  );
}

/** The tabs of an initiative or phase, in their order. */
export type ContainerTab = 'work' | 'details' | 'timeline' | 'artifacts';

/** What the page adds to an initiative's or phase's tabs: the selected one, and the Timeline. */
export type ContainerTabs = {
  tab: ContainerTab | undefined;
  /** Open `tab`; `replace` swaps the URL's entry rather than pushing one. */
  onTab: (tab: ContainerTab, options?: { replace: boolean }) => void;
  /** The Timeline tab's body — the feed and its composer. */
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
 * The tabs an initiative or phase shows, in order, hidden when empty: Work
 * once it holds tasks or `liveDeliveries` (a delivery may name no tasks),
 * Details and Timeline always (a record always has its dates and its
 * creation), Artifacts once one is attached.
 */
export function containerTabs(record: EngineNode, timelineCount: number, liveDeliveries: boolean) {
  const artifacts = record.artifacts?.length ?? 0;
  const tabs: RecordTab<ContainerTab>[] = [
    ...(taskCount(record) > 0 || liveDeliveries ? [{ label: 'Work', value: 'work' as const }] : []),
    { label: 'Details', value: 'details' },
    { count: timelineCount, label: 'Timeline', value: 'timeline' },
    ...(artifacts > 0
      ? [{ count: artifacts, label: 'Artifacts', value: 'artifacts' as const }]
      : []),
  ];
  return tabs;
}

/**
 * An initiative's or phase's page. The URL names the tab; with none, or one
 * that is hidden, the page opens on the first tab that has something in it
 * and, once the reads that decide the tabs are current, replaces the URL with
 * that tab, so the page stays on it when the hidden one fills, and it reads as
 * chosen.
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
  container: ContainerTabs;
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
  const asked = container.tab ?? 'work';
  const tab = tabs.find((t) => t.value === asked)?.value ?? tabs[0]?.value ?? 'details';
  // The URL takes the shown tab only from reads made since the page mounted.
  const current =
    container.recordReadAt >= container.since &&
    (!deliveriesDecideWork || deliveries.dataUpdatedAt >= container.since);
  const settle = useEffectEvent(() => {
    container.onTab(tab, { replace: true });
  });
  useEffect(() => {
    if (tab !== asked && current) {
      settle();
    }
  }, [tab, asked, current]);
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
        {tab === 'timeline' && <div className="flex flex-col gap-3">{container.timeline}</div>}
        {tab === 'artifacts' && (
          <ArtifactLinks
            artifacts={newestArtifacts(record.artifacts ?? [], record.artifacts?.length ?? 0)}
          />
        )}
      </RecordTabs>
    </RecordColumn>
  );
}
