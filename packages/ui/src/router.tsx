import {
  createRootRoute,
  createRoute,
  createRouter,
  type SearchSchemaInput,
  stripSearchParams,
} from "@tanstack/react-router";
import { ArtifactsPage } from "./routes/artifacts";
import { FleetPage } from "./routes/fleet";
import { ProjectPage } from "./routes/project";
import { Shell } from "./routes/shell";
import { TasksPage } from "./routes/tasks";

/**
 * Navigation (ADR 0013 §3): URLs name scopes — `/` the fleet, `/p/KEY` a
 * project; everything else is a lens parameter. `view` picks the project
 * lens (board is primary); `node` addresses the detail drawer on either
 * scope. Typed search params carry that contract in the type system.
 */
export type ProjectLens = "board" | "tree";

export interface FleetSearch {
  node?: string;
}

export interface ProjectSearch {
  view: ProjectLens;
  node?: string;
}

const rootRoute = createRootRoute({ component: Shell });

export const fleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): FleetSearch =>
    typeof search.node === "string" ? { node: search.node } : {},
  component: FleetPage,
});

export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$key",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): ProjectSearch => {
    const view: ProjectLens = search.view === "tree" ? "tree" : "board";
    return typeof search.node === "string" ? { view, node: search.node } : { view };
  },
  search: {
    // board is the primary lens — keep the default out of the URL
    middlewares: [stripSearchParams<ProjectSearch>({ view: "board" })],
  },
  component: ProjectPage,
});

export interface ArtifactsSearch {
  project?: string;
  tag?: string;
  q?: string;
  since?: string;
  before?: string;
  a?: string;
  from?: string;
}

export const artifactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/artifacts",
  validateSearch: (search: Record<string, unknown>): ArtifactsSearch => {
    const out: ArtifactsSearch = {};
    for (const k of ["project", "tag", "q", "since", "before", "a", "from"] as const) {
      const v = search[k];
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    return out;
  },
  component: ArtifactsPage,
});

export interface TasksSearch {
  project?: string;
  status?: string;
  q?: string;
  /** The node opened in the drawer overlay (same param the board uses). */
  node?: string;
}

export const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const out: TasksSearch = {};
    for (const k of ["project", "status", "q", "node"] as const) {
      const v = search[k];
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    return out;
  },
  component: TasksPage,
});

const routeTree = rootRoute.addChildren([fleetRoute, projectRoute, artifactsRoute, tasksRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
