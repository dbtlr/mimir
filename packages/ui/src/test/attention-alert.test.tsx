import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

/** MMR-103 — the top-bar alert counts under_review + blocked + stale ("needs you"). */
function renderApp() {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('attentionAlert (MMR-103)', () => {
  it("counts under_review + blocked + stale in the 'needs you' badge", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes('status=under_review')) {
        return Promise.resolve({ items: [{ id: 'MMR-2' }, { id: 'MMR-3' }], total: 2 });
      }
      if (path.includes('status=blocked')) {
        return Promise.resolve({ items: [{ id: 'MMR-5' }], total: 1 });
      }
      if (path.includes('is=stale')) {
        return Promise.resolve({ items: [{ id: 'MMR-9', status: 'ready' }], total: 1 });
      }
      return Promise.resolve({ items: [], total: 0 }); // projects, ready, etc.
    });
    renderApp();
    // 2 + 1 + 1 = 4 distinct items
    await expect(
      screen.findByRole('button', { name: 'Attention: 4 need you' }),
    ).resolves.toBeDefined();
  });

  it("reads 'nothing needs you' when the set is empty", async () => {
    apiGet.mockResolvedValue({
      items: [],
      total: 0,
    });
    renderApp();
    await expect(
      screen.findByRole('button', { name: 'Attention: nothing needs you' }),
    ).resolves.toBeDefined();
  });

  it("uses the singular 'needs' at a count of one", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes('status=under_review')) {
        return Promise.resolve({ items: [{ id: 'MMR-2' }], total: 1 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderApp();
    await expect(
      screen.findByRole('button', { name: 'Attention: 1 needs you' }),
    ).resolves.toBeDefined();
  });
});
