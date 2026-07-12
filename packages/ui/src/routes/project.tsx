import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';

import { isNotFound } from '../api/errors';
import {
  boardDoneQuery,
  boardLiveQuery,
  doctorQuery,
  projectQuery,
  treeQuery,
} from '../api/queries';
import { BoardView } from '../components/board';
import { DistributionBar } from '../components/distribution-bar';
import { NewTaskButton } from '../components/new-task-button';
import { NodeDossier } from '../components/node-dossier';
import { OfflineBanner } from '../components/offline-banner';
import { ProjectSettingsButton } from '../components/project-settings-button';
import { StatusBadge } from '../components/status-badge';
import { TreeView } from '../components/tree';
import { segmentVariants, segmentedTrackClass } from '../components/ui/segmented-control';
import { Skeleton } from '../components/ui/skeleton';
import type { BandMode } from '../lib/bands';
import { buildBoard } from '../lib/board';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { projectRoute } from '../router';
import type { ProjectLens } from '../router';

/** The Board/Tree lens toggle — a routed segmented control on `?view`. */
function LensToggle({ view }: { view: ProjectLens }) {
  const lens = (target: ProjectLens, label: string) => (
    <Link
      from={projectRoute.fullPath}
      search={(prev) => ({ ...prev, view: target })}
      className={segmentVariants({ active: view === target })}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Lens" className={segmentedTrackClass}>
      {lens('board', 'Board')}
      {lens('tree', 'Tree')}
    </nav>
  );
}

/** The swimlane grouping toggle — a routed segmented control on `?bands` (MMR-221). */
function BandsToggle({ bands }: { bands: BandMode }) {
  const band = (target: BandMode, label: string) => (
    <Link
      from={projectRoute.fullPath}
      search={(prev) => ({ ...prev, bands: target })}
      className={segmentVariants({ active: bands === target })}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Bands" className={segmentedTrackClass}>
      {band('phase', 'Phase')}
      {band('release', 'Release')}
      {band('off', 'Off')}
    </nav>
  );
}

/**
 * `/p/$key` — the working surface. The URL names the scope; the lens
 * (`?view=board|tree`), the band grouping (`?bands=phase|release|off`), and the
 * drawer (`?node=KEY-seq`) are search params (ADR 0013 §3 / MMR-221).
 */
export function ProjectPage() {
  const navigate = useNavigate();
  const { key } = projectRoute.useParams();
  const { view, bands, node } = projectRoute.useSearch();

  const project = useQuery(projectQuery(key));
  // Record-damage count for this board (MMR-185) — the amber header chip; a miss
  // just omits the chip.
  const health = useQuery(doctorQuery(key));
  const dropped = health.data?.dropped_total ?? 0;
  const live = useQuery({ ...boardLiveQuery(key), enabled: view === 'board' });
  const done = useQuery({ ...boardDoneQuery(key), enabled: view === 'board' });
  // Fetched for both lenses: the tree view renders it, the board's Phase bands
  // walk it, and cards degrade gracefully if it's missing. Excluded from the
  // board's connectivity so a tree miss never demotes a cached board.
  const tree = useQuery(treeQuery(key));

  const conn = connectivity(view === 'board' ? [project, live, done] : [project, tree]);

  const openNode = (id: string) =>
    void navigate({ search: (prev) => ({ ...prev, node: id }), to: '.' });
  const closeNode = () =>
    void navigate({ search: (prev) => ({ bands: prev.bands, view: prev.view }), to: '.' });

  const boardReady = live.data !== undefined && done.data !== undefined;

  // Archived-404 semantics (ADR 0015): a 404 means the server ANSWERED — this
  // is not "offline". Back-navigating to a just-archived board (or opening a
  // stale bookmark) gets a notice and a way home instead of a sticky false
  // Offline banner; the project query keeps polling, so an unarchive heals
  // straight back into the board.
  if (isNotFound(project.error)) {
    return (
      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col items-start gap-3 p-5">
        <div className="flex items-center gap-3.5">
          <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
            Project unavailable
          </h1>
          <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
            {key}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-ink-dim">
          This project is archived or no longer exists. Archived projects leave the board and
          picker; nothing is deleted.
        </p>
        <Link
          to="/"
          className="text-xs font-semibold text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          ← Back to Overview
        </Link>
      </main>
    );
  }

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          'mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col overflow-y-auto pb-5',
          conn.offline && 'offline-demoted',
        )}
      >
        <header className="flex flex-wrap items-center gap-3.5 px-5 pt-[18px] pb-3">
          <h1 className="truncate text-header font-bold tracking-[-0.01em] text-ink-bright">
            {project.data?.title ?? key}
          </h1>
          <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
            {key}
          </span>
          {project.data !== undefined && <StatusBadge status={project.data.status} />}
          {dropped > 0 && (
            <Link
              to="/doctor"
              search={{ project: key }}
              className="inline-flex items-center gap-1.5 rounded-full bg-status-in-progress/10 px-2.5 py-1 text-tag font-semibold text-status-in-progress-foreground inset-ring inset-ring-status-in-progress/30 transition-colors hover:bg-status-in-progress/16 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-status-in-progress" />
              {dropped} dropped
            </Link>
          )}
          {project.data?.distribution !== undefined && (
            <DistributionBar
              distribution={project.data.distribution}
              className="hidden h-[5px] w-[200px] md:flex"
            />
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            <span className="hidden text-tag text-ink-faint sm:inline">Bands</span>
            <BandsToggle bands={bands} />
            <LensToggle view={view} />
            {project.data !== undefined && (
              <ProjectSettingsButton project={project.data} offline={conn.offline} />
            )}
            <NewTaskButton projectKey={key} offline={conn.offline} onOpenNode={openNode} />
          </div>
        </header>

        {view === 'board' && !boardReady && (live.isPending || done.isPending) && (
          <div className="grid grid-cols-2 gap-1.5 px-5 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        )}
        {view === 'board' && boardReady && (
          <BoardView
            board={buildBoard(live.data.items, done.data.items)}
            bands={bands}
            tree={tree.data}
            onOpenNode={openNode}
            offline={conn.offline}
            distribution={project.data?.distribution}
            doneTotal={done.data.items.length}
            onViewDone={() =>
              void navigate({ search: { project: key, status: 'done' }, to: '/tasks' })
            }
          />
        )}

        {view === 'tree' && tree.isPending && <Skeleton className="mx-5 h-64" />}
        {view === 'tree' && tree.data !== undefined && (
          <div className="px-5">
            <TreeView root={tree.data} onOpenNode={openNode} offline={conn.offline} />
          </div>
        )}

        {((view === 'board' && live.isError && live.data === undefined) ||
          (view === 'tree' && tree.isError && tree.data === undefined)) && (
          <p className="px-5 text-xs text-status-blocked">
            Unreachable, and nothing cached yet — is `mimir serve` running?
          </p>
        )}
      </main>
      <NodeDossier nodeId={node} onClose={closeNode} onOpenNode={openNode} offline={conn.offline} />
    </>
  );
}
