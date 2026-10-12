import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

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
