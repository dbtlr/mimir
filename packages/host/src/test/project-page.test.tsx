import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { emptyRead } from './fixtures';
import { failShellReads, serveShell } from './shell-fns';
import { serveViews } from './views-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

beforeEach(() => {
  serveBrowse();
  serveViews();
});

function renderProject(key: string, search = '') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [`/p/${key}${search}`] }),
    routeTree,
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

describe('project page archived-404 (MMR-230)', () => {
  it('a 404ing project renders the unavailable notice, not a false Offline banner', async () => {
    // Archived-404 semantics: every project-scoped read answers 404, while
    // portfolio reads (shell strips, picker) stay healthy.
    serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects/SR') || path.includes('project=SR')) {
        return Promise.reject(new ApiError(`GET ${path} → 404`, 404));
      }
      return Promise.resolve(emptyRead(path));
    });
    renderProject('SR');

    await expect(screen.findByText(/archived or no longer exists/i)).resolves.toBeDefined();
    // The server answered — the surface must not read as offline.
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
    expect(screen.getByRole('link', { name: /back to the review page/i })).toBeDefined();
  });

  it('an unreachable server still reads as offline, not as not-found', async () => {
    apiGet.mockRejectedValue(new TypeError('fetch failed'));
    failShellReads(new TypeError('fetch failed'));
    renderProject('SR');

    await expect(screen.findByText(/offline — last synced/i)).resolves.toBeDefined();
    expect(screen.queryByText(/archived or no longer exists/i)).toBeNull();
  });
});

/** Serve the MMR project with direction, a description, and two top-level children. */
function serveProject() {
  serveShell({
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
        engineTree({
          id: 'MMR-1',
          parent: 'MMR',
          status: 'in_progress',
          title: 'Hosted backends',
          type: 'initiative',
        }),
        engineTree({
          id: 'MMR-9',
          parent: 'MMR',
          status: 'ready',
          title: 'A loose task',
          type: 'task',
        }),
      ]),
    },
  });
  apiGet.mockImplementation((path: string) => {
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
    return Promise.resolve(emptyRead(path));
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

  it('offers no board view, and its rail has no structure or other views (MMR-487, MMR-496)', async () => {
    serveProject();
    renderProject('MMR');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toStrictEqual(['Direction', 'About']);
    expect(within(rail).queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /board/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
  });

  it('an old /board link reads as no record rather than a board (MMR-487)', async () => {
    serveProject();
    renderProject('MMR', '/board');

    await expect(screen.findByText('No record at /p/MMR/board.')).resolves.toBeDefined();
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
    ['/p/mmr/417?tab=timeline', '/p/MMR/417', '?tab=timeline'],
  ])('moves %s to its canonical spelling', async (url, pathname, search) => {
    serveProject();
    const testRouter = createRouter({
      history: createMemoryHistory({ initialEntries: [url] }),
      routeTree,
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
});
