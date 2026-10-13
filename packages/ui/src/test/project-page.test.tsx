import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { router } from '../router';
import { task, workReport } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

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
    if (path.startsWith('/api/projects/MMR/work?')) {
      return Promise.resolve(workReport());
    }
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
        status: 'in_progress',
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

describe('project page (MMR-450, MMR-470)', () => {
  beforeEach(() => {
    apiSend.mockReset();
  });

  it('opens the project itself at /p/KEY as its work page: title, then direction in full', async () => {
    serveProject();
    renderProject('MMR');

    await expect(screen.findByRole('heading', { level: 1, name: 'Mimir' })).resolves.toBeDefined();
    await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByText('Ship record pages.')).toBeDefined();
    expect(within(rail).getByText('Then the work page.')).toBeDefined();
    expect(within(rail).getByRole('button', { name: 'Edit direction' })).toBeDefined();
    expect(screen.getByText('work').tagName).toBe('STRONG');
  });

  it('outlines its initiatives in the rail, each linked to its page, and not its loose tasks', async () => {
    serveProject();
    renderProject('MMR');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    const structure = await within(rail).findByRole('navigation', { name: 'Structure' });
    await waitFor(() => {
      expect(
        within(structure)
          .getByRole('link', { name: /Hosted backends/ })
          .getAttribute('href'),
      ).toBe('/p/MMR/1');
    });
    expect(within(structure).queryByText('A loose task')).toBeNull();
  });

  it('keeps the board a link away, under Other views, and gone from the head', async () => {
    serveProject();
    renderProject('MMR');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe(
      '/p/MMR/board',
    );
    expect(screen.queryByRole('link', { name: /open board/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
  });

  it('the board links back to the project page', async () => {
    serveProject();
    renderProject('MMR', '/board');

    const title = await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    expect(within(title).getByRole('link').getAttribute('href')).toBe('/p/MMR');
  });

  it('keeps New task and Project settings in the page head', async () => {
    serveProject();
    renderProject('MMR');

    await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'New task' })[0] as HTMLElement);
    await expect(screen.findByRole('dialog', { name: 'New work item' })).resolves.toBeDefined();
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

  it('keeps the phone sheet open under the editor when a save fails, and the draft with it', async () => {
    serveProject();
    apiSend.mockRejectedValue(new Error('write refused'));
    renderProject('MMR');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Direction' }));
    const sheet = await screen.findByRole('dialog', { name: 'Direction' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit direction' }));
    const draft = await screen.findByRole('textbox', { name: 'Direction text' });
    fireEvent.change(draft, { target: { value: 'A new direction.' } });
    // The editor is a portal child of the sheet, so its clicks reach the sheet's
    // choice handler through React; one outside the sheet's body must not close it.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole('textbox', { name: 'Direction text' })).toHaveValue('A new direction.');
    // The editor's modal hides the sheet from the accessibility tree; both stay mounted.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);
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

  it('says so when its structure cannot be read', async () => {
    serveProject();
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/projects/MMR/tree'
        ? Promise.reject(new TypeError('fetch failed'))
        : served?.(path),
    );
    renderProject('MMR');

    await expect(screen.findByText(/couldn’t load the structure/i)).resolves.toBeDefined();
  });
});
