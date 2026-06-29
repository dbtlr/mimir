import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

describe('artifactsPage', () => {
  it('renders the filter search box and the result rows', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects')) {
        return Promise.resolve({ items: [{ id: 'MMR', status: 'ready' }], total: 1 });
      }
      if (path === '/api/artifacts' || path.startsWith('/api/artifacts?')) {
        return Promise.resolve({
          items: [
            {
              id: 'MMR-a8',
              title: 'Artifacts browser',
              project: 'MMR',
              tags: ['kind:spec'],
              created_at: '2026-06-16T00:00:00.000Z',
            },
          ],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const testRouter = createRouter({
      history: createMemoryHistory({ initialEntries: ['/artifacts'] }),
      routeTree: router.routeTree,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
    await expect(screen.findByText('Artifacts browser')).resolves.toBeDefined();
    expect(screen.getByPlaceholderText(/search title and body/i)).toBeDefined();
  });
});
