import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { boardDoneQuery, boardLiveQuery, projectQuery, treeQuery } from "../api/queries";
import { buildAncestry } from "../lib/ancestry";
import { buildBoard } from "../lib/board";
import { connectivity } from "../lib/connectivity";
import { cn } from "../lib/cn";
import { BoardView } from "../components/board";
import { DistributionBar } from "../components/distribution-bar";
import { NewTaskButton } from "../components/new-task-button";
import { NodeDrawer } from "../components/node-drawer";
import { ProjectSettingsButton } from "../components/project-settings-button";
import { OfflineBanner } from "../components/offline-banner";
import { StatusBadge } from "../components/status-badge";
import { Skeleton } from "../components/ui/skeleton";
import { TreeView } from "../components/tree";
import { projectRoute, type ProjectLens } from "../router";

function LensToggle({ view, nodeParam }: { view: ProjectLens; nodeParam: string | undefined }) {
  const lens = (target: ProjectLens, label: string) => (
    <Link
      from={projectRoute.fullPath}
      search={nodeParam === undefined ? { view: target } : { view: target, node: nodeParam }}
      className={cn(
        "microlabel rounded-[5px] px-2.5 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-accent",
        view === target ? "bg-well-700 text-ink-bright" : "text-ink-dim hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Lens" className="flex gap-px rounded-md border border-line bg-well-850 p-px">
      {lens("board", "Board")}
      {lens("tree", "Tree")}
    </nav>
  );
}

/**
 * `/p/$key` — the working surface. The URL names the scope; the lens
 * (`?view=board|tree`) and the drawer (`?node=KEY-seq`) are search params
 * (ADR 0013 §3).
 */
export function ProjectPage() {
  const navigate = useNavigate();
  const { key } = projectRoute.useParams();
  const { view, node } = projectRoute.useSearch();

  const project = useQuery(projectQuery(key));
  const live = useQuery({ ...boardLiveQuery(key), enabled: view === "board" });
  const done = useQuery({ ...boardDoneQuery(key), enabled: view === "board" });
  // Fetched for both lenses: the tree view renders it, and the board uses it to
  // label each card with its `initiative › phase` breadcrumb. Excluded from the
  // board's connectivity so a tree miss never demotes a cached board — the
  // breadcrumb just degrades to absent.
  const tree = useQuery(treeQuery(key));
  const ancestry = tree.data !== undefined ? buildAncestry(tree.data) : undefined;

  const conn = connectivity(view === "board" ? [project, live, done] : [project, tree]);

  const openNode = (id: string) =>
    void navigate({ to: ".", search: (prev) => ({ ...prev, node: id }) });
  const closeNode = () => void navigate({ to: ".", search: (prev) => ({ view: prev.view }) });

  const boardReady = live.data !== undefined && done.data !== undefined;

  return (
    <>
      <OfflineBanner {...conn} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4",
          conn.offline && "offline-demoted",
        )}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex flex-col gap-0.5">
            <h1 className="flex items-baseline gap-2.5">
              <span className="font-mono text-lg font-bold tracking-tight text-ink-bright">
                {key}
              </span>
              <span className="hidden truncate text-[0.75rem] text-ink-dim sm:inline">
                {project.data?.title}
              </span>
            </h1>
            {project.data?.description != null && project.data.description !== "" && (
              <p className="text-[0.75rem] text-ink-dim">{project.data.description}</p>
            )}
          </div>
          {project.data !== undefined && <StatusBadge status={project.data.status} />}
          <div className="ml-auto flex items-center gap-3">
            {project.data?.distribution !== undefined && (
              <DistributionBar
                distribution={project.data.distribution}
                className="hidden w-36 md:flex"
              />
            )}
            {project.data !== undefined && (
              <ProjectSettingsButton project={project.data} offline={conn.offline} />
            )}
            <NewTaskButton projectKey={key} offline={conn.offline} />
            <LensToggle view={view} nodeParam={node} />
          </div>
        </div>

        {view === "board" && !boardReady && (live.isPending || done.isPending) && (
          <div className="grid grid-cols-2 gap-1.5 md:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        )}
        {view === "board" && boardReady && (
          <BoardView
            board={buildBoard(live.data.items, done.data.items)}
            onOpenNode={openNode}
            offline={conn.offline}
            ancestry={ancestry}
            doneTotal={done.data.items.length}
            onViewDone={() =>
              void navigate({ to: "/tasks", search: { project: key, status: "done" } })
            }
          />
        )}

        {view === "tree" && tree.isPending && <Skeleton className="h-64" />}
        {view === "tree" && tree.data !== undefined && (
          <TreeView root={tree.data} onOpenNode={openNode} />
        )}

        {((view === "board" && live.isError && live.data === undefined) ||
          (view === "tree" && tree.isError && tree.data === undefined)) && (
          <p className="text-[0.75rem] text-status-blocked">
            Unreachable, and nothing cached yet — is `mimir serve` running?
          </p>
        )}
      </main>
      <NodeDrawer nodeId={node} onClose={closeNode} onOpenNode={openNode} offline={conn.offline} />
    </>
  );
}
