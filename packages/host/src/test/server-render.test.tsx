import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../router';

describe('a server render of the console', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders /settings/notifications with no matchMedia (MMR-766)', async () => {
    // A server render has no window, so no matchMedia. The shell reads the
    // theme and the installed-app query, and the push healer this browser's
    // standalone state, on every page.
    vi.stubGlobal('matchMedia', undefined);
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/settings/notifications'] }),
      isServer: true,
      routeTree,
    });
    await router.load();
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });

    const html = renderToString(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // The page itself rendered, not only the shell around it.
    expect(html).toMatch(/<h1[^>]*>Notifications<\/h1>/);
  });
});
