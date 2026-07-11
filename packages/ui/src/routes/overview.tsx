import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { archivedProjectsQuery, projectsQuery } from '../api/queries';
import { ArchivedShelf } from '../components/archived-shelf';
import { LaneSection } from '../components/lane-section';
import { NodeDossier } from '../components/node-dossier';
import { OfflineBanner } from '../components/offline-banner';
import { ProjectCard } from '../components/project-card';
import { ActionButton } from '../components/ui/action-button';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { groupIntoLanes } from '../lib/lanes';
import { overviewRoute } from '../router';

/**
 * `/` — the overview as an attention-router (MMR-102): projects grouped into the
 * four Lanes (MMR-101) in highest-wins order, recency-ordered within each,
 * At-rest folded to a count strip. It is `mimir next` lifted to the project
 * level. When the facet is absent (offline / pre-feature cache) it degrades to a
 * flat key-ordered grid — the lane is an overlay, like the ready count, so a
 * miss costs the ordering, not the cached overview.
 */
export function OverviewPage() {
  const navigate = useNavigate();
  const { node } = overviewRoute.useSearch();

  const projects = useQuery(projectsQuery);
  const archived = useQuery(archivedProjectsQuery);
  const archivedProjects = archived.data?.items ?? [];
  const conn = connectivity([projects, archived]);
  const openNode = (id: string) => void navigate({ search: { node: id }, to: '.' });
  const closeNode = () => void navigate({ search: {}, to: '.' });

  return (
    <>
      <OfflineBanner {...conn} />
      {/* tabIndex -1: the archived shelf's focus fallback — unarchiving the
          last archived project unmounts the shelf, and focus lands here. */}
      <main
        tabIndex={-1}
        className={cn(
          'mx-auto flex w-full max-w-7xl min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-5',
          conn.offline && 'offline-demoted',
        )}
      >
        {projects.isPending && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        )}
        {projects.isError && projects.data === undefined && (
          <p className="text-xs text-status-blocked">
            Unreachable, and nothing cached yet — is `mimir serve` running?
          </p>
        )}
        {projects.data !== undefined &&
          (() => {
            const onOpen = (key: string) => void navigate({ params: { key }, to: '/p/$key' });
            if (projects.data.items.length === 0) {
              return (
                <p className="text-xs text-ink-dim">
                  No projects yet — create one with `mimir create project`.
                </p>
              );
            }
            const grouping = groupIntoLanes(projects.data.items);
            const lanes =
              grouping.mode === 'flat' ? (
                <section aria-label="Projects" className="flex flex-col gap-2">
                  <h2 className="microlabel text-ink-faint">Overview</h2>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {grouping.projects.map((project) => (
                      <ProjectCard key={project.id} project={project} onOpen={onOpen} />
                    ))}
                  </div>
                </section>
              ) : (
                grouping.lanes.map((lane) => (
                  <LaneSection
                    key={lane.lane}
                    lane={lane}
                    onOpen={onOpen}
                    collapsible={lane.lane === 'at_rest'}
                  />
                ))
              );
            return (
              <>
                {/* The one solid action per surface; desktop-only header row.
                    The button rides MMR-227's new-project sheet. Suppressed
                    in degraded flat mode, which carries its own "Overview" heading. */}
                {grouping.mode !== 'flat' && (
                  <header className="hidden items-baseline gap-2.5 md:flex">
                    <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">
                      Projects
                    </h1>
                    <span className="text-tag text-ink-faint">{projects.data.items.length}</span>
                    {archivedProjects.length > 0 && (
                      <span className="text-tag text-ink-faint">
                        · {archivedProjects.length} archived
                      </span>
                    )}
                    <ActionButton
                      className="ml-auto px-3.5 py-1.5"
                      disabled={conn.offline}
                      onClick={() => {
                        // TODO(MMR-227): open the new-project sheet (21a) once landed.
                      }}
                    >
                      + New project
                    </ActionButton>
                  </header>
                )}
                {lanes}
              </>
            );
          })()}
        {/* Below the last lane: the Archived shelf (MMR-125) — absent entirely
            at zero; a folded count row otherwise. Frozen, not empty-stated. */}
        <ArchivedShelf projects={archivedProjects} offline={conn.offline} />
      </main>
      <NodeDossier nodeId={node} onClose={closeNode} onOpenNode={openNode} offline={conn.offline} />
    </>
  );
}
