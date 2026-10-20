import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getNode } from '../api/fns/nodes';
import { updateProject } from '../api/fns/shell';
import { nodeRoute, projectRoute } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { failShellReads, serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

beforeEach(() => {
  serveBrowse();
  serveViews();
});

const routes = [nodeRoute, projectRoute];

const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('project page archived-404 (MMR-230)', () => {
  it('a 404ing project renders the unavailable notice, not a false Offline banner', async () => {
    // Archived-404 semantics: every project-scoped read answers 404, while
    // portfolio reads (shell strips, picker) stay healthy.
    serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
    serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
    await renderRoute(routes, '/p/SR', quietClient());

    await expect(screen.findByText(/archived or no longer exists/i)).resolves.toBeDefined();
    // The server answered — the surface must not read as offline.
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
    expect(screen.getByRole('link', { name: /back to the review page/i })).toBeDefined();
  });

  it('an unreachable server still reads as offline, not as not-found', async () => {
    failShellReads(new TypeError('fetch failed'));
    serveNodes();
    vi.mocked(getNode).mockRejectedValue(new TypeError('fetch failed'));
    await renderRoute(routes, '/p/SR', quietClient());

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
  serveNodes({
    nodes: [
      engineProject({
        description: 'The **work** tool.',
        distribution: { in_progress: 1, ready: 1 },
        id: 'MMR',
        next: 'Ship record pages.\n\nThen the work page.',
        title: 'Mimir',
      }),
    ],
  });
}

describe('project page (MMR-450, MMR-470)', () => {
  it('opens the project itself at /p/KEY as its work page: title, then direction in full', async () => {
    serveProject();
    await renderRoute(routes, '/p/MMR', quietClient());

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
    await renderRoute(routes, '/p/MMR', quietClient());

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
    await renderRoute(routes, '/p/MMR/board', quietClient());

    await expect(screen.findByText('No record at /p/MMR/board.')).resolves.toBeDefined();
  });

  it('keeps New task and Project settings in the page head', async () => {
    serveProject();
    await renderRoute(routes, '/p/MMR', quietClient());

    await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'New task' })[0] as HTMLElement);
    await expect(screen.findByRole('dialog', { name: 'New work item' })).resolves.toBeDefined();
  });

  it("rewrites the direction from the phone's Direction sheet", async () => {
    serveProject();
    await renderRoute(routes, '/p/MMR', quietClient());
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Direction' }));
    const sheet = await screen.findByRole('dialog', { name: 'Direction' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit direction' }));
    await expect(screen.findByRole('textbox', { name: 'Direction text' })).resolves.toBeDefined();
  });

  it('keeps the phone sheet open under the editor when a save fails, and the draft with it', async () => {
    serveProject();
    vi.mocked(updateProject).mockRejectedValue(new Error('write refused'));
    await renderRoute(routes, '/p/MMR', quietClient());
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
      expect(updateProject).toHaveBeenCalledOnce();
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
    const { router: testRouter } = await renderRoute(routes, url, quietClient());

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe(pathname);
    });
    expect(testRouter.state.location.searchStr).toBe(search);
  });
});
