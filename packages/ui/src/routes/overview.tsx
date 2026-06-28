import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projectsQuery } from "../api/queries";
import { connectivity } from "../lib/connectivity";
import { groupIntoBands } from "../lib/attention-bands";
import { cn } from "../lib/cn";
import { BandSection } from "../components/band-section";
import { ProjectCard } from "../components/project-card";
import { NodeDrawer } from "../components/node-drawer";
import { OfflineBanner } from "../components/offline-banner";
import { Skeleton } from "../components/ui/skeleton";
import { overviewRoute } from "../router";

/**
 * `/` — the overview as an attention-router (MMR-102): projects grouped into the
 * four attention-bands (MMR-101) in highest-wins order, recency-ordered within
 * each, At-rest folded to a count strip. It is `mimir next` lifted to the
 * project level. When the facet is absent (offline / pre-feature cache) it
 * degrades to a flat key-ordered grid — attention is an overlay, like the ready
 * count, so a miss costs the ordering, not the cached overview.
 */
export function OverviewPage() {
  const navigate = useNavigate();
  const { node } = overviewRoute.useSearch();

  const projects = useQuery(projectsQuery);
  const conn = connectivity([projects]);
  const openNode = (id: string) => void navigate({ to: ".", search: { node: id } });
  const closeNode = () => void navigate({ to: ".", search: {} });

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-7xl min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4",
          conn.offline && "offline-demoted",
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
            const onOpen = (key: string) => void navigate({ to: "/p/$key", params: { key } });
            if (projects.data.items.length === 0) {
              return (
                <p className="text-xs text-ink-dim">
                  No projects yet — create one with `mimir create project`.
                </p>
              );
            }
            const grouping = groupIntoBands(projects.data.items);
            if (grouping.mode === "flat") {
              return (
                <section aria-label="Projects" className="flex flex-col gap-2">
                  <h2 className="microlabel text-ink-faint">Overview</h2>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {grouping.projects.map((project) => (
                      <ProjectCard key={project.id} project={project} onOpen={onOpen} />
                    ))}
                  </div>
                </section>
              );
            }
            return grouping.bands.map((band) => (
              <BandSection
                key={band.band}
                band={band}
                onOpen={onOpen}
                collapsible={band.band === "at_rest"}
              />
            ));
          })()}
      </main>
      <NodeDrawer nodeId={node} onClose={closeNode} onOpenNode={openNode} />
    </>
  );
}
