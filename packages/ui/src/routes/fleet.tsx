import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projectsQuery, readyQuery } from "../api/queries";
import { connectivity } from "../lib/connectivity";
import { countByProject } from "../lib/counts";
import { cn } from "../lib/cn";
import { FleetCard } from "../components/fleet-card";
import { NodeDrawer } from "../components/node-drawer";
import { OfflineBanner } from "../components/offline-banner";
import { Skeleton } from "../components/ui/skeleton";
import { fleetRoute } from "../router";

/**
 * `/` — the fleet: one card per project, each leading with its ready count.
 * Stuck work (blocked + stale) lives in the global attention alert in the top
 * bar now, not a fleet-only strip.
 */
export function FleetPage() {
  const navigate = useNavigate();
  const { node } = fleetRoute.useSearch();

  const projects = useQuery(projectsQuery);
  // Ready counts are an overlay — excluded from connectivity so a miss degrades
  // a card to "0 ready" rather than demoting the whole cached fleet.
  const ready = useQuery(readyQuery);
  const readyByKey = countByProject(ready.data?.items ?? []);
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
        <section aria-label="Projects" className="flex flex-col gap-2">
          <h2 className="microlabel text-ink-faint">Fleet</h2>
          {projects.isPending && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          )}
          {projects.isError && projects.data === undefined && (
            <p className="text-[0.75rem] text-status-blocked">
              Unreachable, and nothing cached yet — is `mimir serve` running?
            </p>
          )}
          {projects.data !== undefined && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.data.items.map((project) => (
                <FleetCard
                  key={project.id}
                  project={project}
                  ready={readyByKey.get(project.id) ?? 0}
                  onOpen={(key) => void navigate({ to: "/p/$key", params: { key } })}
                />
              ))}
            </div>
          )}
        </section>
      </main>
      <NodeDrawer nodeId={node} onClose={closeNode} onOpenNode={openNode} />
    </>
  );
}
