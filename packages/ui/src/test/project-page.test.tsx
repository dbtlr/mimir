import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

function renderProject(key: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [`/p/${key}`] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('projectPage archived-404 (MMR-230)', () => {
  it('a 404ing project renders the unavailable notice, not a false Offline banner', async () => {
    // Archived-404 semantics: every project-scoped read answers 404, while
    // portfolio reads (shell strips, picker) stay healthy.
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects/SR') || path.includes('project=SR')) {
        return Promise.reject(new ApiError(`GET ${path} → 404`, 404));
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderProject('SR');

    await expect(screen.findByText(/archived or no longer exists/i)).resolves.toBeDefined();
    // The server answered — the surface must not read as offline.
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
    expect(screen.getByRole('link', { name: /back to overview/i })).toBeDefined();
  });

  it('an unreachable server still reads as offline, not as not-found', async () => {
    apiGet.mockRejectedValue(new TypeError('fetch failed'));
    renderProject('SR');

    await expect(screen.findByText(/offline — last synced/i)).resolves.toBeDefined();
    expect(screen.queryByText(/archived or no longer exists/i)).toBeNull();
  });
});
