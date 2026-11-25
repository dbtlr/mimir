import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { isNotFound } from '../api/errors';
import { projectQuery } from '../api/node-queries';
import { connectivity } from '../lib/connectivity';
import type { ConnectivitySource } from '../lib/connectivity';
import { useArchivedProject } from '../lib/use-archived-project';
import { OfflineBanner } from './offline-banner';
import { RecordTabs } from './patterns/record-tabs';
import type { RecordTab } from './patterns/record-tabs';
import { UnavailableProject } from './project-unavailable';
import { Skeleton } from './ui/skeleton';
import { ContainerHead, RecordColumn } from './work-page';

/** A project page's tabs: Work and Details at `/p/KEY`, the rest its browsers. */
export type ProjectTab = 'work' | 'tasks' | 'seeds' | 'artifacts' | 'details';

/**
 * A project's tabs in order (ADR 0013, MMR-726 refinement): Work, Tasks,
 * Seeds, Artifacts, Details. Tasks hides while the project holds no task,
 * Seeds while it has none, and Artifacts while nothing is frozen to it;
 * Details always shows. The tab being shown always shows, and is the only one
 * while the project's record has not arrived. Seeds reads the record's seed
 * tally (MMR-787): it shows while any seed exists, settled ones included, and
 * counts the open ones, so the tab row never loads the seed history.
 */
export function projectTabs(
  project: EngineNode | undefined,
  current: ProjectTab,
): RecordTab<ProjectTab>[] {
  // The leaf tally, not the rollup: the rollup counts roots and drops an idle open-ended one.
  const tasks = Object.values(project?.leafCounts ?? {}).some((count) => count > 0);
  const artifacts = project?.artifacts?.length ?? project?.artifactCount ?? 0;
  const seeds = project?.seedCounts ?? { open: 0, total: 0 };
  const all: (RecordTab<ProjectTab> & { shown: boolean })[] = [
    { label: 'Work', shown: project !== undefined, value: 'work' },
    { label: 'Tasks', shown: tasks, value: 'tasks' },
    {
      count: seeds.open > 0 ? seeds.open : undefined,
      label: 'Seeds',
      shown: seeds.total > 0,
      value: 'seeds',
    },
    {
      count: artifacts > 0 ? artifacts : undefined,
      label: 'Artifacts',
      shown: artifacts > 0,
      value: 'artifacts',
    },
    { label: 'Details', shown: project !== undefined, value: 'details' },
  ];
  return all
    .filter((tab) => tab.shown || tab.value === current)
    .map(({ shown: _shown, ...tab }) => tab);
}

/** The header's place while the project's record is on its way, or the notice when it cannot come. */
function HeadPending({ unreachable }: { unreachable: boolean }) {
  return unreachable ? (
    <p className="text-xs text-status-blocked-foreground">
      Unreachable, and nothing cached yet — is the Mimir host running?
    </p>
  ) : (
    <div className="flex flex-col gap-2" aria-busy>
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-5 w-1/3" />
    </div>
  );
}

/**
 * A project's page around one of its tabs: the record header and the tab row,
 * with the tab's content below. `/p/KEY` (Work, Details) and the project's
 * browsers (`/p/KEY/tasks`, `/seeds`, `/artifacts`) all render in it, so a
 * project reads as one page whichever tab is open. The frame owns the
 * page's two states that are not the page: a project the server answers 404
 * for (archived or gone, ADR 0015), or a key that reads back as another kind
 * of record, shows the unavailable notice in its place,
 * with no Offline banner, since the server answered; otherwise the banner
 * reads the project and the tab's own `reads` (ADR 0013 §5).
 */
export function ProjectFrame({
  projectKey,
  tab,
  reads,
  children,
}: {
  projectKey: string;
  tab: ProjectTab;
  /** The tab's own reads, which count toward the page's connectivity. */
  reads: readonly ConnectivitySource[];
  children: ReactNode;
}) {
  // An archived project's record 404s; once the archived list names the key,
  // stop asking, so a retry or poll cannot swap the notice for the page.
  const archived = useArchivedProject(projectKey);
  const project = useQuery({ ...projectQuery(projectKey), enabled: archived === undefined });
  // A node id in the project segment (`/p/MMR-5/tasks`) names no project either.
  const notProject = project.data !== undefined && project.data.type !== 'project';
  const navigate = useNavigate();

  if (archived !== undefined || isNotFound(project.error) || notProject) {
    return <UnavailableProject projectKey={projectKey} />;
  }
  const conn = connectivity([project, ...reads]);
  const { offline } = conn;

  const open = (next: ProjectTab) => {
    const params = { key: projectKey };
    switch (next) {
      case 'work': {
        return navigate({ params, to: '/p/$key' });
      }
      case 'details': {
        return navigate({ params, search: { tab: 'details' }, to: '/p/$key' });
      }
      case 'tasks': {
        return navigate({ params, to: '/p/$key/tasks' });
      }
      case 'seeds': {
        return navigate({ params, to: '/p/$key/seeds' });
      }
      case 'artifacts': {
        return navigate({ params, to: '/p/$key/artifacts' });
      }
      default: {
        const _exhaustive: never = next;
        return _exhaustive;
      }
    }
  };

  return (
    <>
      <OfflineBanner {...conn} />
      <RecordColumn offline={offline}>
        {project.data === undefined ? (
          <HeadPending unreachable={project.isError} />
        ) : (
          // Keyed by the project: the frame outlives a change of project (Back
          // to a cached one), and an editor opened from More must close with
          // the project it was opened for rather than save into the next.
          <ContainerHead key={project.data.id} record={project.data} offline={offline} />
        )}
        <RecordTabs
          manual
          tabs={projectTabs(project.data, tab)}
          value={tab}
          onSelect={(next) => void open(next)}
        >
          {children}
        </RecordTabs>
      </RecordColumn>
    </>
  );
}
