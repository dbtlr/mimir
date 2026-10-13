import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { WireReviewReport } from '../api/types';
import { router } from '../router';
import { reviewReport, seed } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

/**
 * The top-bar alert (ADR 0019, MMR-476 refinement) counts decisions only and
 * links to the review page at `/`.
 */
function renderAt(path: string, report: WireReviewReport) {
  apiGet.mockImplementation((p: string) =>
    Promise.resolve(p === '/api/review' ? report : { items: [], total: 0 }),
  );
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

const MMR = { key: 'MMR', name: 'Mimir' };

describe('the attention alert', () => {
  it('links to the review page with the count of decisions', async () => {
    const testRouter = renderAt(
      '/tasks',
      reviewReport({ queue: ['LM-196', 'MMR-52', 'MMR-480', 'NORN-393'] }),
    );
    const alert = await screen.findByRole('link', { name: '4 need you' });
    expect(alert.getAttribute('href')).toBe('/');
    await userEvent.click(alert);
    expect(testRouter.state.location.pathname).toBe('/');
  });

  it('reads in the singular for one decision', async () => {
    renderAt('/tasks', reviewReport({ queue: ['MMR-52'] }));
    await expect(screen.findByRole('link', { name: '1 needs you' })).resolves.toBeDefined();
  });

  it('is absent when nothing needs a decision, however much waits in triage', async () => {
    renderAt(
      '/',
      reviewReport({
        projects: [{ ...MMR, decisions: 0, in_flight: 0, triage: 15 }],
        triage: [
          { findings: 12, going_cold: 2, project: MMR, seeds: [seed({ lane: 'untriaged' })] },
        ],
      }),
    );
    // The page's own heading proves the review read has landed.
    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    expect(screen.queryByRole('link', { name: /needs? you/ })).toBeNull();
  });
});
