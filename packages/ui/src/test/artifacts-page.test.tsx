import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import type { WireArtifactSummary } from '../api/types';
import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

const summary = (n: number): WireArtifactSummary => ({
  created_at: '2026-06-16T00:00:00.000Z',
  id: `MMR-a${String(n)}`,
  project: 'MMR',
  tags: [],
  title: `Artifact ${String(n)}`,
});

function renderArtifactsPage() {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: ['/artifacts'] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('artifactsPage', () => {
  it('renders the filter search box and the result rows', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects')) {
        return Promise.resolve({ items: [{ id: 'MMR', status: 'ready' }], total: 1 });
      }
      if (path.startsWith('/api/artifacts?')) {
        return Promise.resolve({
          items: [
            {
              created_at: '2026-06-16T00:00:00.000Z',
              id: 'MMR-a8',
              project: 'MMR',
              tags: ['kind:spec'],
              title: 'Artifacts browser',
            },
          ],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    renderArtifactsPage();
    await expect(screen.findByText('Artifacts browser')).resolves.toBeDefined();
    expect(screen.getByPlaceholderText(/search title \+ body/i)).toBeDefined();
    expect(screen.getByText('1 frozen')).toBeDefined();
    expect(screen.getByText('newest first · windowed, scroll for more')).toBeDefined();
  });

  it('scrolling the list pulls the next window, so every artifact is reachable', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects')) {
        return Promise.resolve({ items: [], total: 0 });
      }
      if (path.startsWith('/api/artifacts?')) {
        const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
        if (params.get('offset') === '100') {
          return Promise.resolve({ items: [summary(101)], total: 101 });
        }
        return Promise.resolve({
          items: Array.from({ length: 100 }, (_, i) => summary(i + 1)),
          total: 101,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    renderArtifactsPage();
    // First window: an explicit limit, 100 rows on screen, the pre-window total.
    await expect(screen.findByText('Artifact 1')).resolves.toBeDefined();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('limit=100'));
    expect(screen.getByText('101 frozen')).toBeDefined();
    expect(screen.queryByText('Artifact 101')).toBeNull();
    // Scrolling near the bottom fetches the next offset window.
    fireEvent.scroll(screen.getByTestId('artifact-scroll'));
    await expect(screen.findByText('Artifact 101')).resolves.toBeDefined();
  });
});
