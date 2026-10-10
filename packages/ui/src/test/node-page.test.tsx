import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import type { WireNode, WireTreeNode } from '../api/types';
import { router } from '../router';
import { task } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

function container(
  id: string,
  type: 'initiative' | 'phase',
  title: string,
  children: WireTreeNode[],
): WireTreeNode {
  return {
    children,
    created_at: '2026-06-01T10:00:00.000Z',
    id,
    parent: null,
    status: 'ready',
    title,
    type,
    updated_at: '2026-06-01T10:00:00.000Z',
  };
}

const TREE: WireTreeNode = {
  children: [
    container('MMR-1', 'initiative', 'Hosted and external backends', [
      container('MMR-2', 'phase', 'SQLite replaces Norn', [
        { ...task({ id: 'MMR-417', status: 'ready' }), children: [] },
      ]),
    ]),
  ],
  created_at: '2026-06-01T10:00:00.000Z',
  id: 'MMR',
  parent: null,
  status: 'in_progress',
  title: 'Mimir',
  type: 'project',
  updated_at: '2026-06-01T10:00:00.000Z',
};

/** Serve `node` at its detail path, the MMR tree, and an empty list everywhere else. */
function serve(node: WireNode, extra: Record<string, unknown> = {}) {
  apiGet.mockImplementation((path: string) => {
    if (path in extra) {
      return Promise.resolve(extra[path]);
    }
    if (path === `/api/nodes/${node.id}`) {
      return Promise.resolve(node);
    }
    if (path === '/api/projects/MMR/tree') {
      return Promise.resolve(TREE);
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderAt(url: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

const sqlite = task({
  description: 'SQLite dialect over `bun:sqlite`.',
  id: 'MMR-417',
  parent: 'MMR-2',
  status: 'ready',
  title: 'Add the SQLite dialect',
});

beforeEach(() => {
  apiGet.mockReset();
});

describe('task page (MMR-449)', () => {
  it('opens a task directly at its URL', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(screen.getByText('bun:sqlite')).toBeDefined();
    expect(screen.getByRole('textbox', { name: /note/i })).toBeDefined();
  });

  it('links every crumb in the path above the task', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');

    const crumbs = await screen.findByRole('navigation', { name: 'Path' });
    await waitFor(() => {
      expect(within(crumbs).getByRole('link', { name: 'Mimir' }).getAttribute('href')).toBe(
        '/p/MMR',
      );
    });
    expect(
      within(crumbs)
        .getByRole('link', { name: 'Hosted and external backends' })
        .getAttribute('href'),
    ).toBe('/p/MMR/1');
    expect(
      within(crumbs).getByRole('link', { name: 'SQLite replaces Norn' }).getAttribute('href'),
    ).toBe('/p/MMR/2');
  });

  it('redirects a bare id, in any case, to the record page', async () => {
    serve(sqlite);
    const testRouter = renderAt('/mmr-417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
  });

  it('redirects a bare project key to the project page', async () => {
    serve(sqlite);
    const testRouter = renderAt('/MMR');

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR');
    });
  });

  it('shows its own not-found state when no record has the id', async () => {
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-999'
        ? Promise.reject(new ApiError(`GET ${path} → 404`, 404))
        : Promise.resolve({ items: [], total: 0 }),
    );
    renderAt('/p/MMR/999');

    await expect(screen.findByText(/no record MMR-999/i)).resolves.toBeDefined();
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
  });

  it('names no node for a suffix that is not a node id, without a lookup', async () => {
    serve(sqlite);
    renderAt('/p/MMR/s41');

    await expect(screen.findByText(/no record at \/p\/MMR\/s41/i)).resolves.toBeDefined();
    expect(apiGet.mock.calls.some(([path]) => String(path).startsWith('/api/nodes/'))).toBe(false);
  });

  it('asks for a verdict while the task is under review', async () => {
    serve({ ...sqlite, external_ref: 'https://github.com/x/pull/360', status: 'under_review' });
    renderAt('/p/MMR/417');

    await expect(screen.findByText(/needs your verdict/i)).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
  });

  it('offers a container no verdict and no task actions, whatever its rollup reads', async () => {
    serve({
      ...task({
        id: 'MMR-2',
        parent: 'MMR-1',
        status: 'under_review',
        title: 'SQLite replaces Norn',
      }),
      type: 'phase',
    });
    renderAt('/p/MMR/2');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'SQLite replaces Norn' }),
    ).resolves.toBeDefined();
    expect(screen.queryByText(/needs your verdict/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /park/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('links what the task depends on and what it blocks to their pages', async () => {
    serve({
      ...sqlite,
      deps: {
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        depends_on: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    renderAt('/p/MMR/417');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-418/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/418');
  });

  it('folds the rail into chips that open bottom sheets on a phone', async () => {
    serve({
      ...sqlite,
      deps: {
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        depends_on: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    renderAt('/p/MMR/417');

    const chips = await screen.findByRole('group', { name: 'Record details' });
    fireEvent.click(within(chips).getByRole('button', { name: /links/i }));

    const sheet = await screen.findByRole('dialog', { name: /links/i });
    expect(
      within(sheet)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
  });

  it('shows where an agent is working on it, with its Scratchpad', async () => {
    serve(
      { ...sqlite, branch: 'feat/mmr-417-sqlite', harness: 'claude-code', status: 'in_progress' },
      {
        '/api/scratchpads?project=MMR': {
          items: [
            {
              id: 'a',
              linked_work: ['MMR-417'],
              open_agenda: 1,
              project: 'MMR',
              state: 'active',
              title: 'SQLite cutover episode',
              updated_at: '2026-06-01T10:00:00.000Z',
            },
            {
              id: 'b',
              linked_work: ['MMR-12'],
              open_agenda: 0,
              project: 'MMR',
              state: 'active',
              title: 'Unrelated episode',
              updated_at: '2026-06-01T10:00:00.000Z',
            },
          ],
          total: 2,
        },
      },
    );
    renderAt('/p/MMR/417');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await expect(within(rail).findByText('SQLite cutover episode')).resolves.toBeDefined();
    expect(within(rail).getByText('claude-code')).toBeDefined();
    expect(within(rail).getByText('feat/mmr-417-sqlite')).toBeDefined();
    expect(within(rail).queryByText('Unrelated episode')).toBeNull();
  });
});
