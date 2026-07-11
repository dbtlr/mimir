import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireHome, WireNode } from '../api/types';
import { router } from '../router';
import { task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

/** A home facet under project MMR; `open` marks the parent as a standing home. */
function home(parentTitle: string, open = false): WireHome {
  return {
    parent_id: 'MMR-1',
    parent_open_ended: open ? true : null,
    parent_title: parentTitle,
    project_key: 'MMR',
  };
}

/** Four tasks spanning the row treatments, deliberately NOT in activity order. */
const rows: WireNode[] = [
  task({
    home: home('Wire hardening'),
    id: 'MMR-10',
    priority: 'p1',
    size: 'small',
    status: 'ready',
    title: 'Doctor the wire',
    updated_at: '2026-06-11T10:00:00.000Z',
  }),
  task({
    home: home('Storage cutover', true),
    id: 'MMR-12',
    status: 'done',
    title: 'Land the schema',
    updated_at: '2026-06-10T12:00:00.000Z',
  }),
  task({
    home: home('Storage cutover', true),
    id: 'MMR-11',
    status: 'under_review',
    title: 'Review the cutover',
    updated_at: '2026-06-11T11:00:00.000Z',
  }),
  task({
    home: home('Wire hardening'),
    id: 'MMR-13',
    status: 'abandoned',
    title: 'Old dead end',
    updated_at: '2026-06-05T12:00:00.000Z',
  }),
];

function mockApi() {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/projects')) {
      return Promise.resolve({
        items: [
          { id: 'MMR', status: 'in_progress', title: 'Mimir' },
          { id: 'NRN', status: 'ready', title: 'Norn' },
        ],
        total: 2,
      });
    }
    if (path.includes('limit=1')) {
      // the all-time census — only `total` is consumed
      return Promise.resolve({ items: [], total: 318 });
    }
    if (path.startsWith('/api/nodes?')) {
      return Promise.resolve({ items: rows, total: rows.length });
    }
    if (path.includes('/annotations')) {
      return Promise.resolve({ items: [], total: 0 });
    }
    if (path.startsWith('/api/nodes/')) {
      // the dossier's detail fetch after a row click
      return Promise.resolve(rows[0]);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderTasks(initial = '/tasks') {
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

const search = (r: ReturnType<typeof renderTasks>) =>
  r.state.location.search as { project?: string; status?: string; q?: string; node?: string };

describe('tasksPage (17a, MMR-228)', () => {
  it('renders the header counts, the six column headers, and the footer echo', async () => {
    mockApi();
    renderTasks();
    await expect(screen.findByText('Doctor the wire')).resolves.toBeDefined();
    expect(screen.getByText('318 across 2 projects · 4 match')).toBeDefined();
    for (const h of ['STATUS', 'ID', 'TITLE', 'HOME', 'SIGNALS', 'ACTIVITY']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeDefined();
    }
    expect(screen.getByText('sorted by last activity · URL-addressable')).toBeDefined();
    expect(screen.getByText('4 matches · 4 shown')).toBeDefined();
    expect(screen.getByText('/tasks')).toBeDefined();
    // the list read is the portfolio task selection
    const nodeCall = apiGet.mock.calls
      .map((c) => c[0] as string)
      .find((p) => p.startsWith('/api/nodes?') && !p.includes('limit=1'));
    expect(nodeCall).toContain('type=task');
  });

  it('sorts by last activity (newest first) and renders HOME with the ∞ marker', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    const dataRows = screen.getAllByRole('row').slice(1); // [0] is the column-header row
    expect(dataRows.map((r) => r.getAttribute('aria-label'))).toStrictEqual([
      'Under review MMR-11 Review the cutover',
      'Ready MMR-10 Doctor the wire',
      'Done MMR-12 Land the schema',
      'Abandoned MMR-13 Old dead end',
    ]);
    const reviewRow = screen.getByRole('row', { name: /MMR-11/ });
    expect(within(reviewRow).getByText('MMR')).toBeDefined();
    expect(reviewRow.textContent).toContain('› Storage cutover');
    // the ∞ glyph carries its meaning without a mouse (role=img + aria-label,
    // not a bare title attribute)
    expect(
      within(reviewRow).getByRole('img', { name: 'open-ended — a standing home' }).textContent,
    ).toContain('∞');
  });

  it('demotes terminal rows by ink tier (never opacity or a row ground) and tints under_review', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');
    const review = screen.getByRole('row', { name: /MMR-11/ });
    expect(review.className).toContain('bg-attention/3');

    const done = screen.getByRole('row', { name: /MMR-12/ });
    // well-recessed is defined against the card ground — on the page well it
    // reads RAISED in both themes, inverting the demotion (skeleton.tsx trap)
    expect(done.className).not.toContain('bg-well-recessed');
    expect(done.className).not.toContain('opacity');
    expect(within(done).getByText('Land the schema').className).toContain('text-ink-dim');

    const abandoned = screen.getByRole('row', { name: /MMR-13/ });
    expect(within(abandoned).getByText('Old dead end').className).toContain('line-through');
    // the ABANDONED word stays legible (the abandoned foreground token fails AA
    // as text at microlabel size) — ink-dim, never the illegible status tone
    const label = within(abandoned).getByText('Abandoned');
    expect(label.className).toContain('text-ink-dim');
    expect(label.className).not.toContain('text-status-abandoned-foreground');
    // metadata cells hold the ink-faint baseline rather than dropping to ghost
    expect(within(abandoned).getByText('MMR-13').className).toContain('text-ink-faint');
  });

  it('status chips toggle in and out of the URL (filter → URL round trip)', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    await user.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBe('ready');
    });
    expect(screen.getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('/tasks?status=ready')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBeUndefined();
    });
  });

  it('restores a deep-linked filter set exactly (G19) and threads the comma union', async () => {
    mockApi();
    renderTasks('/tasks?status=under_review,ready,done&project=MMR&q=cutover');
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'cutover');
    expect(screen.getByRole('button', { name: 'Remove project filter MMR' })).toBeDefined();
    for (const chip of ['Under review', 'Ready', 'Done']) {
      expect(screen.getByRole('button', { name: chip }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(
      screen.getByText('/tasks?q=cutover&project=MMR&status=under_review,ready,done'),
    ).toBeDefined();
    const nodeCall = apiGet.mock.calls
      .map((c) => c[0] as string)
      .find((p) => p.startsWith('/api/nodes?') && p.includes('q=cutover'));
    expect(nodeCall).toContain('project=MMR');
    expect(nodeCall).toContain('status=under_review%2Cready%2Cdone');
  });

  it('the overflow discloses the rest of the vocabulary, terminal words first-class', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    // default track = first three task words; the other five fold away
    await user.click(screen.getByRole('button', { name: '+5 ▾' }));
    await expect(screen.findByRole('menuitem', { name: 'Done' })).resolves.toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Abandoned' })).toBeDefined();
    // `new` is container-only (the selector rejects it) — never offered here
    expect(screen.queryByRole('menuitem', { name: 'New' })).toBeNull();

    await user.click(screen.getByRole('menuitem', { name: 'Abandoned' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBe('abandoned');
    });
  });

  it('shows a deep-linked union selector as an active chip and preserves it on toggle', async () => {
    mockApi();
    const testRouter = renderTasks('/tasks?status=terminal');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    // the active union is visible — never an invisible filter (old /tasks
    // bookmarks carry status=terminal/all)
    const union = screen.getByRole('button', { name: 'Terminal' });
    expect(union.getAttribute('aria-pressed')).toBe('true');

    // toggling a word keeps the union rather than silently discarding it
    await user.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBe('ready,terminal');
    });

    // the union chip is removable on its own
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBe('ready');
    });
  });

  it('toggling a word off keeps a live union (status=done,live → live)', async () => {
    mockApi();
    const testRouter = renderTasks('/tasks?status=done,live');
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    expect(screen.getByRole('button', { name: 'Live' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(search(testRouter).status).toBe('live');
    });
    expect(screen.getByText('/tasks?status=live')).toBeDefined();
  });

  it('never renders a pressed chip for the container-only `new` on a deep link', async () => {
    mockApi();
    renderTasks('/tasks?status=new');
    await screen.findByText('Doctor the wire');

    // `new` is not a task status word: no chip claims it, nothing is pressed
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    for (const chip of ['In progress', 'Under review', 'Ready']) {
      expect(screen.getByRole('button', { name: chip }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('keeps the column-header row in the accessibility tree at every width', async () => {
    mockApi();
    renderTasks();
    await screen.findByText('Doctor the wire');

    // Below md the header row must hide visually (sr-only), never display:none —
    // otherwise mobile screen readers get cells with no columnheader to associate.
    const headerGroup = screen
      .getByRole('columnheader', { name: 'STATUS' })
      .closest('[role="rowgroup"]');
    expect(headerGroup?.className).toContain('max-md:sr-only');
    expect(headerGroup?.className).not.toContain('max-md:hidden');
  });

  it('a row click opens the dossier via ?node=', async () => {
    mockApi();
    const testRouter = renderTasks();
    const user = userEvent.setup();
    await screen.findByText('Doctor the wire');

    await user.click(screen.getByRole('row', { name: /MMR-10/ }));
    await waitFor(() => {
      expect(search(testRouter).node).toBe('MMR-10');
    });
  });

  it('unreachable with nothing cached keeps the honest error and disables + New task', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    renderTasks();
    await expect(
      screen.findByText(/Unreachable — is `mimir serve` running\?/),
    ).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: '+ New task' })).toHaveProperty('disabled', true);
  });
});
