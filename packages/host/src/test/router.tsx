import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { AnyRoute } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { createContext, useContext } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';

const Children = createContext<ReactNode>(null);

/**
 * Renders a component under a bare memory router, so its `Link`s resolve to
 * real hrefs and a click moves `router.state.location`. The router loads before
 * the first render, so the tree is present synchronously, and it reads the tree
 * from context, so `rerender` keeps the same router and history.
 */
export async function renderInRouter(ui: ReactElement, client = new QueryClient()) {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({ component: () => useContext(Children) }),
  });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <Children.Provider value={children}>
          <RouterProvider router={router} />
        </Children.Provider>
      </QueryClientProvider>
    );
  }
  await router.load();
  return { ...render(ui, { wrapper }), router };
}

/**
 * Renders real page routes under a bare root that is just an `<Outlet />`, so a
 * page test mounts the page and its route, not the console `Shell` (sidebar,
 * jump palette, Toaster, review query, health checks).
 *
 * Why it works: pages read their route through route-bound hooks
 * (`tasksRoute.useParams()`), which TanStack resolves by route id. A route
 * computes its id and full path from its parent only once a router has built
 * it, so the helper first builds the real console router (never rendered) to
 * give the shared route singletons their real ids. The test tree then swaps in
 * a fresh bare `createRootRoute` (it keeps the id `__root__`) with the given
 * routes as its children. Routes are shared, but the router, history, and match
 * state are new for every call, so nothing leaks between tests.
 *
 * Use it for any page test: pass the route(s) the test needs, e.g.
 * `renderRoute([tasksRoute], '/p/MMR/tasks?status=ready')`. A link to a route
 * left out of the list changes `router.state.location` and renders the
 * not-found fallback, which suits tests that only check where a click goes.
 * Pass `wrapper` to supply a context the shell normally provides, such as
 * `SeedCaptureProvider` for the seeds page. Tests of the shell itself keep
 * mounting `routeTree`.
 */
export async function renderRoute(
  routes: readonly AnyRoute[],
  initial: string,
  client = new QueryClient(),
  Wrapper?: ComponentType<{ children: ReactNode }>,
) {
  // Imported lazily, so renderInRouter's tests never load the route tree.
  (await import('../router')).createConsoleRouter();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: createRootRoute({
      component:
        Wrapper === undefined
          ? Outlet
          : () => (
              <Wrapper>
                <Outlet />
              </Wrapper>
            ),
    }).addChildren([...routes]),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}
