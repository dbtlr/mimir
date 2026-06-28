import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { artifactsQuery, projectsQuery, type ArtifactFilters as Filters } from "../api/queries";
import { projectKeyOf } from "../api/types";
import { connectivity } from "../lib/connectivity";
import { cn } from "../lib/cn";
import { ArtifactFilters } from "../components/artifact-filters";
import { ArtifactList } from "../components/artifact-list";
import { ArtifactReader } from "../components/artifact-reader";
import { OfflineBanner } from "../components/offline-banner";
import { Skeleton } from "../components/ui/skeleton";
import { artifactsRoute } from "../router";

const FILTER_KEYS = ["project", "tag", "q", "since", "before"] as const;

/** `/artifacts` — the portfolio artifact browser (master-detail). */
export function ArtifactsPage() {
  const navigate = useNavigate();
  const search = artifactsRoute.useSearch();
  const filters: Filters = {};
  for (const k of FILTER_KEYS) {
    if (search[k] !== undefined) filters[k] = search[k];
  }

  const projects = useQuery(projectsQuery);
  const artifacts = useQuery(artifactsQuery(filters));
  const conn = connectivity([projects, artifacts]);

  // `replace` so a filter edit replaces the current history entry rather than
  // pushing one per keystroke (Back should leave the browser, not unwind typing).
  const setFilter = (partial: Partial<Filters>) =>
    void navigate({
      to: "/artifacts",
      replace: true,
      search: (prev) => {
        const next = { ...prev, ...partial };
        for (const [k, v] of Object.entries(partial)) {
          if (v === "" || v === undefined) delete (next as Record<string, unknown>)[k];
        }
        return next;
      },
    });

  const select = (id: string) =>
    void navigate({ to: "/artifacts", search: (prev) => ({ ...prev, a: id }) });

  const back = () => {
    if (search.from !== undefined) {
      const from = search.from;
      void navigate({
        to: "/p/$key",
        params: { key: projectKeyOf(from) },
        search: { view: "board", node: from },
      });
    } else {
      void navigate({
        to: "/artifacts",
        search: (prev) => ({ ...prev, a: undefined, from: undefined }),
      });
    }
  };

  const openNode = (nodeId: string) =>
    void navigate({
      to: "/p/$key",
      params: { key: projectKeyOf(nodeId) },
      search: { view: "board", node: nodeId },
    });

  const selected = search.a;

  return (
    <>
      <OfflineBanner {...conn} />
      <main className={cn("flex min-h-0 flex-1 flex-col", conn.offline && "offline-demoted")}>
        <h1 className="flex items-baseline gap-2 px-4 pt-3">
          <span className="font-mono text-lg font-bold tracking-tight text-ink-bright">
            Artifacts
          </span>
          {artifacts.data !== undefined && (
            <span className="text-xs text-ink-dim">{artifacts.data.total}</span>
          )}
        </h1>

        <ArtifactFilters
          filters={filters}
          projects={(projects.data?.items ?? []).map((p) => p.id)}
          onChange={setFilter}
        />

        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 w-full overflow-auto border-line md:w-80 md:shrink-0 md:border-r",
              selected !== undefined && "hidden md:block",
            )}
          >
            {artifacts.isPending && <Skeleton className="m-2 h-40" />}
            {artifacts.data !== undefined && (
              <ArtifactList items={artifacts.data.items} selectedId={selected} onSelect={select} />
            )}
            {artifacts.isError && artifacts.data === undefined && (
              <p className="p-4 text-xs text-status-blocked">
                Unreachable — is `mimir serve` running?
              </p>
            )}
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              selected !== undefined ? "flex" : "hidden md:flex",
            )}
          >
            {selected !== undefined ? (
              <ArtifactReader id={selected} onBack={back} onOpenNode={openNode} />
            ) : (
              <p className="hidden w-full items-center justify-center p-8 text-xs text-ink-faint md:flex">
                Select an artifact to read.
              </p>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
