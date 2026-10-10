import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { router } from '../router';
import { task } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

function renderProject(key: string, search = '') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [`/p/${key}${search}`] }),
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

describe.each([
  ['project page', ''],
  ['board', '/board'],
])('%s archived-404 (MMR-230)', (_surface, suffix) => {
  it('a 404ing project renders the unavailable notice, not a false Offline banner', async () => {
    // Archived-404 semantics: every project-scoped read answers 404, while
    // portfolio reads (shell strips, picker) stay healthy.
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects/SR') || path.includes('project=SR')) {
        return Promise.reject(new ApiError(`GET ${path} → 404`, 404));
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderProject('SR', suffix);

    await expect(screen.findByText(/archived or no longer exists/i)).resolves.toBeDefined();
    // The server answered — the surface must not read as offline.
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
    expect(screen.getByRole('link', { name: /back to overview/i })).toBeDefined();
  });

  it('an unreachable server still reads as offline, not as not-found', async () => {
    apiGet.mockRejectedValue(new TypeError('fetch failed'));
    renderProject('SR', suffix);

    await expect(screen.findByText(/offline — last synced/i)).resolves.toBeDefined();
    expect(screen.queryByText(/archived or no longer exists/i)).toBeNull();
  });
});

describe('board direction (MMR-390)', () => {
  it('a project with direction folds its first line under the board header', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects/MMR/tree') {
        return Promise.resolve({ children: [], id: 'MMR', title: 'Mimir', type: 'project' });
      }
      if (path.startsWith('/api/projects/MMR')) {
        return Promise.resolve({
          description: null,
          distribution: {},
          id: 'MMR',
          next: 'Ship the direction line.\n\nThen the dossier.',
          status: 'in_progress',
          title: 'Mimir',
          type: 'project',
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    renderProject('MMR', '/board');

    await expect(screen.findByText('Ship the direction line.')).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: /direction/i })).toBeDefined();
    // The fold is one line — the rest stays in the dialog.
    expect(screen.queryByText(/Then the dossier/)).toBeNull();
  });
});

describe('board record links (MMR-449)', () => {
  it("a tree row opens the task's page", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/projects/MMR/tree') {
        return Promise.resolve({
          children: [
            { ...task({ id: 'MMR-7', status: 'ready', title: 'Leaf task' }), children: [] },
          ],
          id: 'MMR',
          title: 'Mimir',
          type: 'project',
        });
      }
      if (path === '/api/projects/MMR') {
        return Promise.resolve({ id: 'MMR', status: 'ready', title: 'Mimir', type: 'project' });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    const testRouter = renderProject('MMR', '/board?view=tree');

    await userEvent.click(await screen.findByText('Leaf task'));
    expect(testRouter.state.location.pathname).toBe('/p/MMR/7');
  });
});

/** Serve the MMR project with direction, a description, and two top-level children. */
function serveProject() {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/projects/MMR/tree') {
      return Promise.resolve({
        children: [
          {
            ...task({ id: 'MMR-1', status: 'in_progress', title: 'Hosted backends' }),
            children: [],
            type: 'initiative',
          },
          { ...task({ id: 'MMR-9', status: 'ready', title: 'A loose task' }), children: [] },
        ],
        id: 'MMR',
        title: 'Mimir',
        type: 'project',
      });
    }
    if (path === '/api/projects/MMR') {
      return Promise.resolve({
        description: 'The **work** tool.',
        distribution: { in_progress: 1, ready: 1 },
        id: 'MMR',
        next: 'Ship record pages.\n\nThen the work page.',
        status: 'in_progress',
        title: 'Mimir',
        type: 'project',
      });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

describe('project page (MMR-450)', () => {
  it('opens the project itself at /p/KEY: title, description, and direction in full', async () => {
    serveProject();
    renderProject('MMR');

    await expect(screen.findByRole('heading', { level: 1, name: 'Mimir' })).resolves.toBeDefined();
    expect(screen.getByText('work').tagName).toBe('STRONG');
    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByText('Ship record pages.')).toBeDefined();
    expect(within(rail).getByText('Then the work page.')).toBeDefined();
    expect(within(rail).getByRole('button', { name: 'Edit direction' })).toBeDefined();
  });

  it('lists its top-level work, each linked to its page', async () => {
    serveProject();
    renderProject('MMR');

    const contents = await screen.findByRole('region', { name: /contents/i });
    await waitFor(() => {
      expect(
        within(contents)
          .getByRole('link', { name: /Hosted backends/ })
          .getAttribute('href'),
      ).toBe('/p/MMR/1');
    });
    expect(
      within(contents)
        .getByRole('link', { name: /A loose task/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/9');
  });

  it('links to the board, which lives at /p/KEY/board', async () => {
    serveProject();
    renderProject('MMR');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getByRole('link', { name: /open board/i })
        .getAttribute('href'),
    ).toBe('/p/MMR/board');
  });

  it('the board links back to the project page', async () => {
    serveProject();
    renderProject('MMR', '/board');

    const title = await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    expect(within(title).getByRole('link').getAttribute('href')).toBe('/p/MMR');
  });

  it('a phone sheet stays open under a dialog its button opens, and inside that dialog', async () => {
    serveProject();
    renderProject('MMR');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Actions' }));
    const actions = await screen.findByRole('dialog', { name: 'Actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'New task' }));
    const authoring = await screen.findByRole('dialog', { name: 'New work item' });
    // A click inside the new dialog reaches the sheet only through React's
    // portal bubbling; it must not close the sheet out from under the dialog.
    fireEvent.click(within(authoring).getByRole('radio', { name: 'Phase' }));
    expect(screen.getByRole('dialog', { name: 'New work item' })).toBeDefined();
    // The modal on top hides the sheet from the accessibility tree; both stay mounted.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);
  });

  it("rewrites the direction from the phone's Direction sheet", async () => {
    serveProject();
    renderProject('MMR');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Direction' }));
    const sheet = await screen.findByRole('dialog', { name: 'Direction' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit direction' }));
    await expect(screen.findByRole('textbox', { name: 'Direction text' })).resolves.toBeDefined();
  });

  it.each([
    ['/p/mmr', '/p/MMR', ''],
    ['/p/mmr/board?view=tree', '/p/MMR/board', '?view=tree'],
  ])('moves %s to its canonical spelling', async (url, pathname, search) => {
    serveProject();
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

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe(pathname);
    });
    expect(testRouter.state.location.searchStr).toBe(search);
  });

  it('says so when its contents cannot be read', async () => {
    serveProject();
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/projects/MMR/tree'
        ? Promise.reject(new TypeError('fetch failed'))
        : served?.(path),
    );
    renderProject('MMR');

    await expect(screen.findByText(/couldn’t load the contents/i)).resolves.toBeDefined();
  });
});
