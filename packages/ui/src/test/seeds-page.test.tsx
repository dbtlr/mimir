import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireSeed } from '../api/types';
import { router } from '../router';
import { seed } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

/** One seed per lane, plus two terminal rows for the settled fold. */
const list: WireSeed[] = [
  seed({ id: 'MMR-s1', kind: 'bug', lane: 'untriaged', title: 'Scroll snaps to top' }),
  seed({
    id: 'MMR-s2',
    kind: 'feature',
    lane: 'ready',
    lifecycle: 'promoted',
    ready_to_resolve: true,
    spawned: ['MMR-118'],
    title: 'Offline banner flicker',
  }),
  seed({ id: 'MMR-s3', lane: 'promoted', lifecycle: 'promoted', spawned: ['MMR-90'] }),
  seed({ id: 'MMR-s4', lane: 'settled', lifecycle: 'resolved' }),
  seed({ id: 'MMR-s5', lane: 'settled', lifecycle: 'rejected' }),
];

function mockApi() {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/health') {
      return Promise.resolve({ schema: 1, status: 'ok', version: '0.0.0' });
    }
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [{ id: 'MMR', status: 'in_progress', title: 'Mimir' }],
        total: 1,
      });
    }
    if (path.startsWith('/api/seeds?')) {
      return Promise.resolve({ items: list, total: list.length });
    }
    if (path === '/api/seeds/MMR-s2') {
      return Promise.resolve({
        ...list[1],
        description: 'The banner repaints on every wake.',
      });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderSeeds(initial = '/seeds') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } })
      }
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('seedsPage (13a/14a, MMR-247)', () => {
  it('renders lanes in fixed order with counts and the header summary', async () => {
    mockApi();
    renderSeeds();
    const untriaged = await screen.findByText('UNTRIAGED · 1');
    const ready = screen.getByText('READY TO RESOLVE · 1');
    const promoted = screen.getByText('PROMOTED · 1');

    // header summary
    expect(screen.getByText('1 to triage · 1 to resolve')).toBeDefined();

    // DOM order is the fixed lane order (FOLLOWING bit set ⇒ later in the tree)
    expect(untriaged.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(ready.compareDocumentPosition(promoted) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('folds SETTLED to a strip with resolved/rejected counts', async () => {
    mockApi();
    renderSeeds();
    await screen.findByText('UNTRIAGED · 1');
    expect(screen.getByText('Settled · 2')).toBeDefined();
    expect(screen.getByText('1 resolved · 1 rejected')).toBeDefined();
  });

  it('the detail meta rail renders a null requester as "you" and lists spawned work', async () => {
    mockApi();
    renderSeeds('/seeds?seed=MMR-s2');
    await screen.findByText('The banner repaints on every wake.');

    // meta rail
    expect(screen.getByText('REQUESTER')).toBeDefined();
    expect(screen.getByText('you')).toBeDefined();
    // spawned work id shows on the master row and the SPAWNED rail alike
    expect(screen.getAllByText('MMR-118').length).toBeGreaterThan(0);
    // the ready lane leads with the resolve verb (renamed from the mock's "dispose")
    expect(screen.getAllByRole('button', { name: 'Resolve — done' }).length).toBeGreaterThan(0);
  });

  it('never says "dispose" anywhere — the shipped copy is "resolve"', async () => {
    mockApi();
    renderSeeds('/seeds?seed=MMR-s2');
    await screen.findByText('The banner repaints on every wake.');
    expect(document.body.textContent?.toLowerCase()).not.toContain('dispose');
    expect(document.body.textContent).toContain('READY TO RESOLVE');
  });
});
