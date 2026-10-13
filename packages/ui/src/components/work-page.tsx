import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { ApiError } from '../api/errors';
import { browserTimeZone, workQuery } from '../api/queries';
import { projectKeyOf } from '../api/types';
import type { WireArtifact, WireNode, WireTreeNode } from '../api/types';
import { ancestorsOf } from '../lib/ancestry';
import { cn } from '../lib/cn';
import { nodeLink } from '../lib/record-url';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { absoluteTime } from '../lib/time';
import { RAIL_ARTIFACT_CAP, buildOutline, newestArtifacts } from '../lib/work-page';
import type { OutlineEntry, OutlineTally } from '../lib/work-page';
import { DirectionPanel } from './direction-line';
import { DistributionBar } from './distribution-bar';
import { FindingsChip } from './findings-chip';
import { MarkdownBody } from './markdown-body';
import { NewTaskButton } from './new-task-button';
import {
  ArtifactLinks,
  MetaRow,
  RefRow,
  SignalBadges,
  hasSignals,
  prerequisiteRows,
} from './node-record';
import { ProjectSettingsButton } from './project-settings-button';
import { RailSection, RecordLayout } from './record-layout';
import type { RailChip } from './record-layout';
import { StatusBadge } from './status-badge';
import { StatusDot } from './status-dot';
import { Skeleton } from './ui/skeleton';
import { WorkSections } from './work-sections';

/*
 * The work page (ADR 0013, MMR-467 refinement): a project, initiative, or phase
 * opens as five question-ordered sections beside a rail of Direction,
 * Structure, About, Artifacts, and Other views. One implementation serves all three
 * scopes; a container adds its path above the title and a Work | Timeline tab bar.
 */

/** The path above a record: its project, then each container down to its parent. */
export function Crumbs({
  projectKey,
  tree,
  nodeId,
}: {
  projectKey: string;
  tree?: WireTreeNode;
  nodeId: string;
}) {
  const ancestors = tree === undefined ? [] : (ancestorsOf(tree, nodeId) ?? []);
  const crumb =
    'rounded-sm font-mono text-tag text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <nav aria-label="Path" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <Link to="/p/$key" params={{ key: projectKey }} className={crumb}>
        {tree?.title ?? projectKey}
      </Link>
      {ancestors.map((a) => (
        <span key={a.id} className="flex items-baseline gap-1.5">
          <span aria-hidden className="text-tag text-ink-faint">
            ›
          </span>
          <Link {...nodeLink(a.id)} className={crumb}>
            {a.title}
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** `11 done · 2 parked · 1 in progress` — the rollup's counts, in the status system's order. */
function distributionLegend(distribution: NonNullable<WireNode['distribution']>): string {
  return STATUS_ORDER.filter((word) => (distribution[word] ?? 0) > 0)
    .map((word) => `${String(distribution[word])} ${STATUS_META[word].label.toLowerCase()}`)
    .join(' · ');
}

/** The tab a container's page shows: its work sections or its notes. */
export type WorkTab = 'work' | 'timeline';

/** What a container adds to the page: the Work | Timeline tabs, and the Timeline's own content. */
export type ContainerTabs = {
  tab: WorkTab;
  onTab: (tab: WorkTab) => void;
  /** The Timeline tab's body — the feed and its composer. */
  timeline: ReactNode;
  timelineCount: number;
};

function WorkHead({
  record,
  isProject,
  tree,
  findings,
  offline,
}: {
  record: WireNode;
  isProject: boolean;
  tree?: WireTreeNode;
  findings: number;
  offline: boolean;
}) {
  const projectKey = projectKeyOf(record.id);
  const legend = record.distribution === undefined ? '' : distributionLegend(record.distribution);
  return (
    <header className="flex flex-col gap-1.5">
      {!isProject && <Crumbs projectKey={projectKey} tree={tree} nodeId={record.id} />}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-mono-id text-ink-faint">
          {record.id} · {isProject ? 'project' : record.type}
        </span>
        <StatusBadge status={record.status} pill />
        {isProject && <FindingsChip projectKey={projectKey} findings={findings} />}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-dossier leading-[1.35] font-bold tracking-[-0.01em] text-ink-bright md:text-header">
          {record.title}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <NewTaskButton
            projectKey={projectKey}
            offline={offline}
            home={isProject ? undefined : record.id}
          />
          {isProject && <ProjectSettingsButton project={record} offline={offline} />}
        </div>
      </div>
      {record.distribution !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DistributionBar
            distribution={record.distribution}
            className="h-[5px] w-full max-w-[160px]"
          />
          {legend !== '' && <span className="text-tag text-ink-faint">{legend}</span>}
        </div>
      )}
    </header>
  );
}

/** What a Structure row shows at its right edge: done over total, ∞, or parked. */
function tallyText(tally: OutlineTally): string {
  switch (tally.kind) {
    case 'counts': {
      return `${String(tally.done)}/${String(tally.total)}`;
    }
    case 'open_ended': {
      return '∞';
    }
    case 'parked': {
      return 'parked';
    }
    default: {
      const _exhaustive: never = tally;
      return _exhaustive;
    }
  }
}

const OUTLINE_ROW =
  'flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-accent/10 aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent/28';

/** An outline row is current on its own page only, whatever tab or search it is read under. */
const OUTLINE_ACTIVE = { exact: true, includeSearch: false } as const;

function OutlineRow({ entry, currentId }: { entry: OutlineEntry; currentId: string }) {
  const current = entry.id === currentId;
  return (
    <Link
      {...nodeLink(entry.id)}
      activeOptions={OUTLINE_ACTIVE}
      className={cn(OUTLINE_ROW, current ? 'text-ink-bright' : 'text-ink')}
      style={{ marginLeft: `${String(entry.depth * 0.75)}rem` }}
    >
      <StatusDot status={entry.status} />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      <span className="shrink-0 font-mono text-mono-id text-ink-faint">
        {tallyText(entry.tally)}
      </span>
    </Link>
  );
}

/**
 * The Structure outline: "All work" for the project, then its initiatives and
 * phases (never its tasks), each at its own page with its progress. Finished
 * top-level initiatives fold into one disclosure, open when the page is inside one.
 */
function StructureOutline({
  tree,
  unavailable,
  currentId,
}: {
  tree: WireTreeNode | undefined;
  unavailable: boolean;
  currentId: string;
}) {
  if (tree === undefined) {
    return unavailable ? (
      <p className="text-xs text-ink-faint">Couldn’t load the structure.</p>
    ) : (
      <Skeleton className="h-16 w-full" />
    );
  }
  const outline = buildOutline(tree);
  const insideFinished = outline.finished.entries.some((e) => e.id === currentId);
  return (
    <nav aria-label="Structure" className="flex flex-col gap-px">
      <Link
        to="/p/$key"
        params={{ key: tree.id }}
        activeOptions={OUTLINE_ACTIVE}
        className={cn(OUTLINE_ROW, currentId === tree.id ? 'text-ink-bright' : 'text-ink')}
      >
        <StatusDot status={tree.status} />
        <span className="min-w-0 flex-1 truncate">All work</span>
        <span className="shrink-0 font-mono text-mono-id text-ink-faint">
          {outline.root.done}/{outline.root.total}
        </span>
      </Link>
      {outline.entries.length === 0 && outline.finished.count === 0 && (
        <p className="px-1.5 py-1 text-xs text-ink-faint">
          No initiatives or phases. This scope holds tasks only.
        </p>
      )}
      {outline.entries.map((entry) => (
        <OutlineRow key={entry.id} entry={entry} currentId={currentId} />
      ))}
      {outline.finished.count > 0 && (
        <details open={insideFinished}>
          <summary className="cursor-pointer rounded-sm px-1.5 py-1 text-xs text-ink-faint focus-visible:outline-2 focus-visible:outline-accent">
            {outline.finished.count} finished{' '}
            {outline.finished.count === 1 ? 'initiative' : 'initiatives'}
          </summary>
          {outline.finished.entries.map((entry) => (
            <OutlineRow key={entry.id} entry={entry} currentId={currentId} />
          ))}
        </details>
      )}
    </nav>
  );
}

/** A small label over a block inside the About rail section. */
function AboutLabel({ children }: { children: ReactNode }) {
  return <h3 className="microlabel text-ink-faint">{children}</h3>;
}

/**
 * The record's description and details — the rail's About. A project with no
 * description points at its settings, the one place it is edited; a container
 * has no editor, so it just says so.
 */
function AboutPanel({ record, isProject }: { record: WireNode; isProject: boolean }) {
  const description = record.description?.trim() ?? '';
  const prerequisites = record.deps === undefined ? [] : prerequisiteRows(record.deps);
  const blocking = record.deps?.blocking ?? [];
  return (
    <div className="flex flex-col gap-3">
      {description === '' ? (
        <p className="text-xs text-ink-faint">
          {isProject ? 'No description yet. Add one in project settings (⚙).' : 'No description.'}
        </p>
      ) : (
        <MarkdownBody breaks className="max-w-none">
          {description}
        </MarkdownBody>
      )}
      {prerequisites.length > 0 && (
        <div className="flex flex-col gap-1">
          <AboutLabel>Depends on</AboutLabel>
          {prerequisites.map((r) => (
            <RefRow key={r.id} refNode={r} />
          ))}
        </div>
      )}
      {blocking.length > 0 && (
        <div className="flex flex-col gap-1">
          <AboutLabel>Blocking · {blocking.length}</AboutLabel>
          {blocking.map((r) => (
            <RefRow key={r.id} refNode={r} />
          ))}
        </div>
      )}
      {hasSignals(record) && <SignalBadges node={record} />}
      <dl className="flex flex-col gap-1">
        <MetaRow label="created">{absoluteTime(record.created_at)}</MetaRow>
        <MetaRow label="updated">{absoluteTime(record.updated_at)}</MetaRow>
        {record.target != null && <MetaRow label="target">{record.target}</MetaRow>}
      </dl>
    </div>
  );
}

/**
 * The rail's Artifacts. A project can hold hundreds, so it lists the newest few
 * and links to the artifact browser filtered to it. A container's attached set
 * is small and the browser has no per-record filter, so it lists them all.
 */
function ArtifactsPanel({
  artifacts,
  projectKey,
  isProject,
}: {
  artifacts: readonly WireArtifact[];
  projectKey: string;
  isProject: boolean;
}) {
  const shown = isProject ? newestArtifacts(artifacts, RAIL_ARTIFACT_CAP) : artifacts;
  return (
    <div className="flex flex-col gap-1">
      <ArtifactLinks artifacts={shown} />
      {isProject && artifacts.length > RAIL_ARTIFACT_CAP && (
        <Link
          to="/artifacts"
          search={{ project: projectKey }}
          className="rounded-sm px-1 py-0.5 text-xs text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          All {artifacts.length} artifacts
        </Link>
      )}
    </div>
  );
}

/** The other lens on the scope: its tasks in the browser. */
function OtherViews({ projectKey }: { projectKey: string }) {
  const link =
    'rounded-sm px-1.5 py-1 text-xs text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <nav aria-label="Other views" className="flex flex-col gap-px">
      <Link to="/tasks" search={{ project: projectKey }} className={link}>
        All tasks in {projectKey}
      </Link>
    </nav>
  );
}

const TABS: readonly { value: WorkTab; label: string }[] = [
  { label: 'Work', value: 'work' },
  { label: 'Timeline', value: 'timeline' },
];

const tabId = (value: WorkTab) => `work-tab-${value}`;
const panelId = (value: WorkTab) => `work-panel-${value}`;

/** The Work | Timeline tab bar of a container; arrows move between the two. */
function WorkTabs({ tabs }: { tabs: ContainerTabs }) {
  const { tab, onTab, timelineCount } = tabs;
  const refs = useRef(new Map<WorkTab, HTMLButtonElement>());
  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const next: WorkTab = tab === 'work' ? 'timeline' : 'work';
    onTab(next);
    refs.current.get(next)?.focus();
  }
  return (
    <div role="tablist" aria-label="Page view" className="flex gap-1 border-b border-line">
      {TABS.map(({ label, value }) => {
        const selected = tab === value;
        return (
          <button
            key={value}
            ref={(el) => {
              if (el === null) {
                refs.current.delete(value);
              } else {
                refs.current.set(value, el);
              }
            }}
            type="button"
            role="tab"
            id={tabId(value)}
            aria-selected={selected}
            // Only the selected panel is rendered, so only its tab names one.
            aria-controls={selected ? panelId(value) : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onTab(value);
            }}
            onKeyDown={handleKey}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-meta font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent',
              selected
                ? 'border-accent text-ink-bright'
                : 'border-transparent text-ink-dim hover:text-ink',
            )}
          >
            {label}
            {value === 'timeline' && (
              <span className="font-mono text-micro text-ink-faint">{timelineCount}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The Work tab's body: the sections, a skeleton while the read is pending, or the failure. */
function WorkBody({
  record,
  projectKey,
  isProject,
  offline,
}: {
  record: WireNode;
  projectKey: string;
  isProject: boolean;
  offline: boolean;
}) {
  const work = useQuery(
    workQuery(
      isProject ? { key: record.id, kind: 'project' } : { id: record.id, kind: 'container' },
    ),
  );
  if (work.data === undefined) {
    return work.isError ? (
      <p className="text-xs text-status-blocked">
        {/* An answered failure (an HTTP status) says no more than that; only a request that never got an answer asks about the server. */}
        {work.error instanceof ApiError
          ? 'Couldn’t load the work page.'
          : 'Couldn’t load the work page, and nothing is cached yet — is `mimir serve` running?'}
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
    <WorkSections
      report={work.data}
      projectKey={projectKey}
      home={isProject ? undefined : record.id}
      zone={browserTimeZone()}
      offline={offline}
    />
  );
}

/**
 * The work page for a project, initiative, or phase. `record` is the scope's own
 * read; `tree` (read once by the caller) outlines the structure and titles the
 * path. `container` is set for an initiative or phase and absent for a project:
 * it adds the Work | Timeline tabs and carries the Timeline's content.
 */
export function WorkPage({
  record,
  tree,
  treeFailed,
  findings = 0,
  offline,
  container,
}: {
  record: WireNode;
  tree: WireTreeNode | undefined;
  treeFailed: boolean;
  /** The project's record-health findings, for its head chip. */
  findings?: number;
  offline: boolean;
  container?: ContainerTabs;
}) {
  const isProject = container === undefined;
  const projectKey = projectKeyOf(record.id);

  const direction = (
    <DirectionPanel
      subject={isProject ? { key: record.id, kind: 'project' } : { id: record.id, kind: 'node' }}
      title={record.title}
      next={record.next}
      offline={offline}
    />
  );
  const structure = <StructureOutline tree={tree} unavailable={treeFailed} currentId={record.id} />;
  const about = <AboutPanel record={record} isProject={isProject} />;
  const artifacts = record.artifacts ?? [];
  const artifactsPanel = (
    <ArtifactsPanel artifacts={artifacts} projectKey={projectKey} isProject={isProject} />
  );
  const views = <OtherViews projectKey={projectKey} />;

  const chips: RailChip[] = [
    { content: direction, label: 'Direction' },
    { content: structure, label: 'Structure' },
    { content: about, label: 'About' },
    ...(artifacts.length > 0 ? [{ content: artifactsPanel, label: 'Artifacts' }] : []),
    { content: views, label: 'Other views' },
  ];
  const rail = (
    <>
      <RailSection label="Direction">{direction}</RailSection>
      <RailSection label="Structure">{structure}</RailSection>
      <RailSection label="About">{about}</RailSection>
      {artifacts.length > 0 && <RailSection label="Artifacts">{artifactsPanel}</RailSection>}
      <RailSection label="Other views">{views}</RailSection>
    </>
  );

  const work = (
    <WorkBody record={record} projectKey={projectKey} isProject={isProject} offline={offline} />
  );
  const body =
    container === undefined ? (
      work
    ) : (
      <>
        <WorkTabs tabs={container} />
        <div
          role="tabpanel"
          id={panelId(container.tab)}
          aria-labelledby={tabId(container.tab)}
          className="flex flex-col gap-3"
        >
          {container.tab === 'work' ? work : container.timeline}
        </div>
      </>
    );

  return (
    <RecordLayout
      head={
        <WorkHead
          record={record}
          isProject={isProject}
          tree={tree}
          findings={findings}
          offline={offline}
        />
      }
      rail={rail}
      chips={chips}
      className={cn(offline && 'offline-demoted')}
    >
      {body}
    </RecordLayout>
  );
}
