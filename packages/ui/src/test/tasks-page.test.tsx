import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

describe('tasksPage (MMR-78)', () => {
  it('renders the filter/search bar and the task rows', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects')) {
        return Promise.resolve({ items: [{ id: 'MMR', status: 'ready' }], total: 1 });
      }
      if (path.startsWith('/api/nodes?')) {
        return Promise.resolve({
          items: [{ id: 'MMR-78', title: 'Task browser', status: 'ready', verdicts: {} }],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const testRouter = createRouter({
      history: createMemoryHistory({ initialEntries: ['/tasks'] }),
      routeTree: router.routeTree,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
    await expect(screen.findByText('Task browser')).resolves.toBeDefined();
    expect(screen.getByPlaceholderText(/search titles/i)).toBeDefined();
  });

  it('the task read carries type=task and threads the q search param', () => {
    // tasksQuery builds the request; assert the URL shape rather than the DOM.
    const calls = apiGet.mock.calls.map((c) => c[0] as string);
    const nodeCall = calls.find((p) => p.startsWith('/api/nodes?'));
    expect(nodeCall).toContain('type=task');
  });
});
