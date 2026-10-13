import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { isNotFound } from '../api/errors';
import {
  boardDoneQuery,
  boardLiveQuery,
  doctorQuery,
  projectQuery,
  treeQuery,
} from '../api/queries';
import { BoardView } from '../components/board';
import { DirectionLine } from '../components/direction-line';
import { DistributionBar } from '../components/distribution-bar';
import { FindingsChip } from '../components/findings-chip';
import { NewTaskButton } from '../components/new-task-button';
import { OfflineBanner } from '../components/offline-banner';
import { ProjectSettingsButton } from '../components/project-settings-button';
import { StatusBadge } from '../components/status-badge';
import { segmentVariants, segmentedTrackClass } from '../components/ui/segmented-control';
import { Skeleton } from '../components/ui/skeleton';
import type { BandMode } from '../lib/bands';
import { buildBoard } from '../lib/board';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { boardRoute } from '../router';
import { ProjectUnavailablePage } from './not-found';

/** The swimlane grouping toggle — a routed segmented control on `?bands` (MMR-221). */
function BandsToggle({ bands }: { bands: BandMode }) {
  const band = (target: BandMode, label: string) => (
    <Link
      from={boardRoute.fullPath}
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
 * `/p/$key/board` — the project's board, a view beside its records (ADR 0013,
 * MMR-467 refinement): an optional view, reached from the work page's Other
 * views. The band grouping (`?bands=phase|release|off`) is a search param
 * (ADR 0013 §3 / MMR-221). The title links back to the project's page.
 */
export function BoardPage() {
  const { key } = boardRoute.useParams();
  const { bands } = boardRoute.useSearch();

  const project = useQuery(projectQuery(key));
  // Record-health finding count for this board (MMR-185) — the amber header
  // chip; a miss just omits the chip.
  const health = useQuery(doctorQuery(key));
  const findings = health.data?.finding_total ?? 0;
  const live = useQuery(boardLiveQuery(key));
  const done = useQuery(boardDoneQuery(key));
  // The board's Phase bands walk the tree, and cards degrade gracefully if it's
  // missing. Excluded from connectivity so a tree miss never demotes a cached
  // board.
  const tree = useQuery(treeQuery(key));

  const conn = connectivity([project, live, done]);

  const boardReady = live.data !== undefined && done.data !== undefined;

  // Archived-404 semantics (ADR 0015): a 404 means the server ANSWERED — this
  // is not "offline". Back-navigating to a just-archived board (or opening a
  // stale bookmark) gets a notice and a way home instead of a sticky false
  // Offline banner; the project query keeps polling, so an unarchive heals
  // straight back into the board.
  if (isNotFound(project.error)) {
    return <ProjectUnavailablePage projectKey={key} />;
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
            <Link
              to="/p/$key"
              params={{ key }}
              className="rounded-sm transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {project.data?.title ?? key}
            </Link>
          </h1>
          <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-tag text-ink-faint inset-ring inset-ring-line-bright">
            {key}
          </span>
          {project.data !== undefined && <StatusBadge status={project.data.status} />}
          <FindingsChip projectKey={key} findings={findings} />
          {project.data?.distribution !== undefined && (
            <DistributionBar
              distribution={project.data.distribution}
              className="hidden h-[5px] w-[200px] md:flex"
            />
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            <span className="hidden text-tag text-ink-faint sm:inline">Bands</span>
            <BandsToggle bands={bands} />
            {project.data !== undefined && (
              <ProjectSettingsButton project={project.data} offline={conn.offline} />
            )}
            <NewTaskButton projectKey={key} offline={conn.offline} />
          </div>
        </header>

        {/* Direction under the header (MMR-390): the owned `## Next` prose
            folded to one line, above the work itself. */}
        {project.data !== undefined && (
          <div className="px-5 pb-3">
            <DirectionLine
              subject={{ key, kind: 'project' }}
              title={project.data.title}
              next={project.data.next}
              offline={conn.offline}
            />
          </div>
        )}

        {!boardReady && (live.isPending || done.isPending) && (
          <div className="grid grid-cols-2 gap-1.5 px-5 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        )}
        {boardReady && (
          <BoardView
            projectKey={key}
            board={buildBoard(live.data.items, done.data.items)}
            bands={bands}
            tree={tree.data}
            offline={conn.offline}
            distribution={project.data?.distribution}
            doneTotal={done.data.items.length}
          />
        )}

        {live.isError && live.data === undefined && (
          <p className="px-5 text-xs text-status-blocked">
            Unreachable, and nothing cached yet — is `mimir serve` running?
          </p>
        )}
      </main>
    </>
  );
}
