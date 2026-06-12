import {
  createRootRoute,
  createRoute,
  createRouter,
  type SearchSchemaInput,
  stripSearchParams,
} from "@tanstack/react-router";
import { FleetPage } from "./routes/fleet";
import { ProjectPage } from "./routes/project";
import { Shell } from "./routes/shell";

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

const routeTree = rootRoute.addChildren([fleetRoute, projectRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
