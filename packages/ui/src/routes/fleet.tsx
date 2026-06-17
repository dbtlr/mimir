import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { blockedQuery, inFlightQuery, projectsQuery, staleQuery } from "../api/queries";
import { projectKeyOf } from "../api/types";
import { connectivity } from "../lib/connectivity";
import { cn } from "../lib/cn";
import { AttentionStrip, attentionItems } from "../components/attention-strip";
import { FleetCard, type FleetAttention } from "../components/fleet-card";
import { NodeDrawer } from "../components/node-drawer";
import { OfflineBanner } from "../components/offline-banner";
import { Skeleton } from "../components/ui/skeleton";
import { fleetRoute } from "../router";

/**
 * `/` — the fleet: the cross-project attention strip up top, one card per
 * project below. Attention counts come from the same three portfolio reads
 * that feed the strip, grouped by project key.
 */
export function FleetPage() {
  const navigate = useNavigate();
  const { node } = fleetRoute.useSearch();

  const projects = useQuery(projectsQuery);
  const inFlight = useQuery(inFlightQuery);
  const blocked = useQuery(blockedQuery);
  const stale = useQuery(staleQuery);

  const conn = connectivity([projects, inFlight, blocked, stale]);
  const openNode = (id: string) => void navigate({ to: ".", search: { node: id } });
  const closeNode = () => void navigate({ to: ".", search: {} });

  const counts = new Map<string, FleetAttention>();
  const countInto = (ids: string[] | undefined, pick: (a: FleetAttention) => void) => {
    for (const id of ids ?? []) {
      const key = projectKeyOf(id);
      const entry = counts.get(key) ?? { inFlight: 0, stale: 0, blocked: 0 };
      pick(entry);
      counts.set(key, entry);
    }
  };
  countInto(
    inFlight.data?.items.map((n) => n.id),
    (a) => a.inFlight++,
  );
  countInto(
    stale.data?.items.map((n) => n.id),
    (a) => a.stale++,
  );
  countInto(
    blocked.data?.items.map((n) => n.id),
    (a) => a.blocked++,
  );

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-7xl min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4",
          conn.offline && "offline-demoted",
        )}
      >
        <section aria-label="Attention" className="flex flex-col gap-2">
          <h2 className="microlabel text-ink-faint">Attention</h2>
          {inFlight.isPending && blocked.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <AttentionStrip
              items={attentionItems(
                inFlight.data?.items ?? [],
                blocked.data?.items ?? [],
                stale.data?.items ?? [],
              )}
              onOpenNode={openNode}
            />
          )}
        </section>

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
                  attention={counts.get(project.id) ?? { inFlight: 0, stale: 0, blocked: 0 }}
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
