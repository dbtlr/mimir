import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireSeed } from '../api/types';
import { router } from '../router';
import { seed } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

/** One seed per live lane, plus two terminal rows for the settled fold. */
const list: WireSeed[] = [
  seed({
    id: 'MMR-s1',
    kind: 'bug',
    lane: 'untriaged',
    lede: 'The list scroll position jumps back to the top on every refetch.',
    title: 'Scroll snaps to top',
  }),
  seed({
    id: 'MMR-s2',
    kind: 'feature',
    lane: 'ready',
    lifecycle: 'promoted',
    ready_to_resolve: true,
    requester: 'NRN',
    spawned: ['MMR-118'],
    title: 'Offline banner flicker',
  }),
  seed({ id: 'MMR-s3', lane: 'promoted', lifecycle: 'promoted', spawned: ['MMR-90'] }),
  seed({ id: 'MMR-s4', lane: 'settled', lifecycle: 'resolved', title: 'Old resolved thing' }),
  seed({ id: 'MMR-s5', lane: 'settled', lifecycle: 'rejected', title: 'Old rejected thing' }),
];

function mockApi(items: WireSeed[] = list) {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/health') {
      return Promise.resolve({ schema: 1, status: 'ok', version: '0.0.0' });
    }
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [
          { id: 'MMR', status: 'in_progress', title: 'Mimir' },
          { id: 'NRN', status: 'ready', title: 'Norn' },
        ],
        total: 2,
      });
    }
    if (path.startsWith('/api/seeds?')) {
      return Promise.resolve({ items, total: items.length });
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

describe('seedsPage (grouped reading list, MMR-454)', () => {
  it('renders the live lanes in fixed order with counted labels and hides empty ones', async () => {
    mockApi();
    renderSeeds();
    const untriaged = await screen.findByText('Untriaged · 1');
    const ready = screen.getByText('Ready to resolve · 1');
    const promoted = screen.getByText('Promoted · 1');
    expect(untriaged.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(ready.compareDocumentPosition(promoted) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('hides a live lane with no seeds', async () => {
    mockApi([seed({ id: 'MMR-s1', lane: 'untriaged' })]);
    renderSeeds();
    await screen.findByText('Untriaged · 1');
    expect(screen.queryByText(/Ready to resolve/)).toBeNull();
    expect(screen.queryByText(/Promoted/)).toBeNull();
    expect(screen.queryByText(/Settled/)).toBeNull();
  });

  it('shows the to-triage and to-resolve counts in the header', async () => {
    mockApi();
    renderSeeds();
    await expect(screen.findByText('1 to triage · 1 to resolve')).resolves.toBeDefined();
  });

  it('omits a zero half of the header count', async () => {
    mockApi([seed({ id: 'MMR-s1', lane: 'untriaged' })]);
    renderSeeds();
    await expect(screen.findByText('1 to triage')).resolves.toBeDefined();
  });

  it('links every row to the seed page and shows kind chip and lede', async () => {
    mockApi();
    renderSeeds();
    const link = await screen.findByRole('link', { name: 'Scroll snaps to top' });
    expect(link).toHaveAttribute('href', '/p/MMR/s1');
    expect(screen.getByRole('link', { name: 'Offline banner flicker' })).toHaveAttribute(
      'href',
      '/p/MMR/s2',
    );
    expect(screen.getByText('bug')).toBeDefined();
    expect(
      screen.getByText('The list scroll position jumps back to the top on every refetch.'),
    ).toBeDefined();
  });

  it('names the requester project only when the seed was filed from another project', async () => {
    mockApi();
    renderSeeds();
    await screen.findByText('Ready to resolve · 1');
    expect(screen.getByText(/^from NRN · /)).toBeDefined();
    expect(screen.getAllByText(/^from /)).toHaveLength(1);
  });

  it('folds settled seeds until "Show settled seeds" reveals them', async () => {
    mockApi();
    const user = userEvent.setup();
    renderSeeds();
    await screen.findByText('Settled · 2');
    expect(screen.queryByText('Old resolved thing')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show settled seeds' }));
    expect(screen.getByRole('link', { name: 'Old resolved thing' })).toHaveAttribute(
      'href',
      '/p/MMR/s4',
    );
    expect(screen.getByText('Old rejected thing')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Hide settled seeds' }));
    expect(screen.queryByText('Old resolved thing')).toBeNull();
  });

  it('searches by title and by id', async () => {
    mockApi();
    const user = userEvent.setup();
    renderSeeds();
    const search = await screen.findByRole('searchbox', { name: 'Search seeds' });
    expect(search).toHaveAttribute('placeholder', 'Search seeds…');

    await user.type(search, 'FLICKER');
    expect(screen.getByText('Offline banner flicker')).toBeDefined();
    expect(screen.queryByText('Scroll snaps to top')).toBeNull();

    await user.clear(search);
    await user.type(search, 'mmr-s1');
    expect(screen.getByText('Scroll snaps to top')).toBeDefined();
    expect(screen.queryByText('Offline banner flicker')).toBeNull();
  });

  it('reflects the search in the q URL param after the debounce', async () => {
    mockApi();
    const user = userEvent.setup();
    const testRouter = renderSeeds();
    await user.type(await screen.findByRole('searchbox', { name: 'Search seeds' }), 'flicker');
    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ q: 'flicker' });
    });
  });

  it('filters by kind and records it in the URL', async () => {
    mockApi();
    const user = userEvent.setup();
    const testRouter = renderSeeds();
    await user.click(await screen.findByRole('button', { name: /Any kind/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'bug' }));

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ kind: 'bug' });
    });
    expect(screen.getByText('Scroll snaps to top')).toBeDefined();
    expect(screen.queryByText('Offline banner flicker')).toBeNull();
  });

  it('applies a kind from the URL and drops an invalid one', async () => {
    mockApi();
    renderSeeds('/seeds?kind=feature');
    await screen.findByText('Offline banner flicker');
    expect(screen.queryByText('Scroll snaps to top')).toBeNull();
    expect(screen.getByRole('button', { name: /feature/ })).toBeDefined();
  });

  it('ignores an invalid kind param', async () => {
    mockApi();
    const testRouter = renderSeeds('/seeds?kind=epic');
    await screen.findByText('Scroll snaps to top');
    expect(testRouter.state.location.search).not.toHaveProperty('kind');
  });

  it('filters by project server-side and shows the chosen key', async () => {
    mockApi();
    renderSeeds('/seeds?project=NRN');
    await screen.findByText('Untriaged · 1');
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('project=NRN'));
    expect(screen.getByRole('button', { name: /NRN/ })).toBeDefined();
  });

  it('says "No seeds match." when the filters exclude everything', async () => {
    mockApi();
    const user = userEvent.setup();
    renderSeeds();
    await user.type(await screen.findByRole('searchbox', { name: 'Search seeds' }), 'zzzzz');
    await expect(screen.findByText('No seeds match.')).resolves.toBeDefined();
  });

  it('keeps the friendly empty copy when there are no seeds at all', async () => {
    mockApi([]);
    renderSeeds();
    await expect(screen.findByText(/No seeds yet/)).resolves.toBeDefined();
  });

  it('no longer opens a reading pane from ?seed=', async () => {
    mockApi();
    renderSeeds('/seeds?seed=MMR-s1');
    await screen.findByText('Untriaged · 1');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText('Select a seed to read.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Promote to task…' })).toBeNull();
  });

  it('opens the seed capture from "+ File a seed"', async () => {
    mockApi();
    const user = userEvent.setup();
    renderSeeds();
    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    await expect(screen.findByLabelText('Seed')).resolves.toBeDefined();
  });

  it('never says "dispose" — the shipped copy is "resolve"', async () => {
    mockApi();
    renderSeeds();
    await screen.findByText('Ready to resolve · 1');
    expect(document.body.textContent?.toLowerCase()).not.toContain('dispose');
  });
});
