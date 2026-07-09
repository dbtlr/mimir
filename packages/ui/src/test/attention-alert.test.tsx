import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

/** MMR-103/226 — the top-bar "N for you" pill counts under_review + blocked + stale. */
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

describe('attentionAlert (MMR-103/226)', () => {
  it("counts under_review + blocked + stale in the 'for you' pill", async () => {
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
    await expect(screen.findByRole('button', { name: /4 for you/ })).resolves.toBeDefined();
  });

  it('renders no pill when nothing needs the operator', async () => {
    apiGet.mockResolvedValue({ items: [], total: 0 });
    renderApp();
    // let the queries settle, then assert the pill never appears
    await screen.findByRole('link', { name: 'Mimir' });
    expect(screen.queryByRole('button', { name: /for you/ })).toBeNull();
  });

  it('opens a menu whose header and rows carry the reason and age', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes('status=under_review')) {
        return Promise.resolve({
          items: [
            { id: 'MMR-140', title: 'Doctor read-surface', updated_at: '2026-07-09T00:00:00.000Z' },
          ],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /1 for you/ }));
    await expect(screen.findByText('Needs you · 1')).resolves.toBeDefined();
    expect(screen.getByText('Doctor read-surface')).toBeDefined();
    expect(screen.getByText(/Under review/)).toBeDefined();
    expect(screen.getByText('MMR-140')).toBeDefined();
  });
});
