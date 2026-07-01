import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireAttention } from '../api/types';
import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

function attn(lane: WireAttention['lane'], lastActivity: string, stale = false): WireAttention {
  return { lane, last_activity: lastActivity, stale };
}

function proj(id: string, attention?: WireAttention) {
  return { attention, distribution: {}, id, status: 'in_progress', title: `${id} project` };
}

function renderOverview() {
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

describe('overviewPage attention-router (MMR-102)', () => {
  it('renders the populated lanes in highest-wins order, At rest collapsed', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({
          items: [
            proj('REVIEW', attn('awaiting_you', '2026-06-20T00:00:00.000Z')),
            proj('LIVE', attn('live', '2026-06-19T00:00:00.000Z')),
            proj('RESTED', attn('at_rest', '2026-06-01T00:00:00.000Z')),
          ],
          total: 3,
        });
      }
      return Promise.resolve({ items: [], total: 0 }); // ready + attention strips
    });
    renderOverview();

    await expect(screen.findByText('Awaiting you')).resolves.toBeDefined();
    expect(screen.getByText('Live')).toBeDefined();
    // needs_unsticking has no members → its header is omitted
    expect(screen.queryByText('Needs unsticking')).toBeNull();
    // At rest is collapsed: a "view all" strip, its card hidden until expanded
    expect(screen.queryByText('RESTED')).toBeNull();
    const strip = screen.getByRole('button', { name: /at rest/i });
    await userEvent.click(strip);
    expect(screen.getByText('RESTED')).toBeDefined();
  });

  it('degrades to a flat Overview grid when the attention facet is absent', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({ items: [proj('OLDCACHE')], total: 1 }); // no attention
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByText('Overview')).resolves.toBeDefined();
    expect(screen.getByText('OLDCACHE')).toBeDefined();
    expect(screen.queryByText('Awaiting you')).toBeNull();
  });

  it('shows an empty state when there are no projects', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects') {
        return Promise.resolve({ items: [], total: 0 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderOverview();

    await expect(screen.findByText(/no projects yet/i)).resolves.toBeDefined();
  });
});
