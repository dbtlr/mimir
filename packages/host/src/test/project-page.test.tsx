import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { list } from '../api/fns/browse';
import { getNode } from '../api/fns/nodes';
import { updateProject } from '../api/fns/shell';
import { projectQuery } from '../api/node-queries';
import { consoleRoutes } from '../router';
import { seedIn } from './browse-fixtures';
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

const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('project page archived-404 (MMR-230)', () => {
  it('a 404ing project renders the unavailable notice, not a false Offline banner', async () => {
    // Archived-404 semantics: every project-scoped read answers 404, while
    // portfolio reads (shell strips, picker) stay healthy.
    serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
    serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
    await renderRoute(consoleRoutes, '/p/SR', quietClient());

    await expect(screen.findByText(/archived or no longer exists/i)).resolves.toBeDefined();
    // The server answered — the surface must not read as offline.
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
    expect(screen.getByRole('link', { name: /back to Home/i })).toBeDefined();
  });

  it('an unreachable server still reads as offline, not as not-found', async () => {
    failShellReads(new TypeError('fetch failed'));
    serveNodes();
    vi.mocked(getNode).mockRejectedValue(new TypeError('fetch failed'));
    await renderRoute(consoleRoutes, '/p/SR', quietClient());

    await expect(screen.findByText(/offline — last synced/i)).resolves.toBeDefined();
    expect(screen.queryByText(/archived or no longer exists/i)).toBeNull();
  });
});

/** Serve the MMR project with direction, a description, and two top-level children. */
function serveProject(extra: Partial<EngineNode> = {}) {
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
        ...extra,
      }),
    ],
  });
}

/** The project page's tab names, in order. */
const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Record views' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent);

describe('project page (MMR-450, MMR-470, MMR-726)', () => {
  it('opens at /p/KEY under its header: title, status line, its description as the summary, Work selected', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    const title = await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    const header = title.closest('header') as HTMLElement;
    // Status first, then the type, then the ID; a project heads its own trail, so it has none.
    expect(header.textContent?.replaceAll(/\s+/g, ' ')).toContain('In progress Project MMR');
    expect(within(header).queryByRole('navigation', { name: 'Ancestors' })).toBeNull();
    expect(within(header).getByText('The **work** tool.')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Work', selected: true })).toBeDefined();
    await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
    // The server function mocks ignore facets, so the request is checked here.
    expect(getNode).toHaveBeenCalledWith({
      data: expect.objectContaining({ facets: expect.arrayContaining(['children']), id: 'MMR' }),
    });
  });

  it('retires the rail and its chips: no Direction, About, or Artifacts chip, and no board view', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    expect(screen.queryByRole('complementary', { name: 'Record details' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Record details' })).toBeNull();
    for (const chip of ['Direction', 'About', 'Artifacts']) {
      expect(screen.queryByRole('button', { name: chip })).toBeNull();
    }
    expect(screen.queryByRole('link', { name: /board/i })).toBeNull();
  });

  it('tabs Work, Tasks, and Details, hiding Seeds and Artifacts while it has none', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    await screen.findByRole('tablist', { name: 'Record views' });
    expect(tabNames()).toStrictEqual(['Work ', 'Tasks ', 'Details ']);
  });

  it('counts open seeds and frozen artifacts on their tabs, in their order', async () => {
    serveProject({
      artifacts: [{ createdAt: new Date(), id: 'MMR-a1', tags: [], title: 'A spec' }],
    });
    serveBrowse({
      seeds: [
        seedIn('untriaged', { id: 'MMR-s1', project: 'MMR' }),
        seedIn('settled', { id: 'MMR-s2', project: 'MMR' }),
      ],
    });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    await screen.findByRole('tab', { name: /Seeds/ });
    expect(tabNames()).toStrictEqual(['Work ', 'Tasks ', 'Seeds 1', 'Artifacts 1', 'Details ']);
  });

  it('shows Seeds with no count while every seed is settled', async () => {
    serveProject();
    serveBrowse({ seeds: [seedIn('settled', { id: 'MMR-s2', project: 'MMR' })] });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    await screen.findByRole('tab', { name: /Seeds/ });
    expect(tabNames()).toStrictEqual(['Work ', 'Tasks ', 'Seeds ', 'Details ']);
  });

  it('moves focus along its tabs with the arrow keys without opening the browsers', async () => {
    serveProject();
    const { router: testRouter } = await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    const work = await screen.findByRole('tab', { name: 'Work' });
    work.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveFocus();
    expect(testRouter.state.location.pathname).toBe('/p/MMR');
    expect(screen.getByRole('tab', { name: 'Work', selected: true })).toBeDefined();
  });

  it('opens Details at ?tab=details, from a reload too, with the Direction and the description in full', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR?tab=details', quietClient());

    await expect(
      screen.findByRole('tab', { name: 'Details', selected: true }),
    ).resolves.toBeDefined();
    expect(screen.getByText('Ship record pages.')).toBeDefined();
    expect(screen.getByText('Then the work page.')).toBeDefined();
    expect(screen.getByText('work').tagName).toBe('STRONG');
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit direction' })).toBeNull();
  });

  it('puts the tab in the URL: Details adds ?tab=details, Work takes it out, Tasks opens the browser', async () => {
    serveProject();
    const { router: testRouter } = await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    fireEvent.click(await screen.findByRole('tab', { name: 'Details' }));
    await waitFor(() => {
      expect(testRouter.state.location.searchStr).toBe('?tab=details');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Work' }));
    await waitFor(() => {
      expect(testRouter.state.location.searchStr).toBe('');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/tasks');
    });
    await expect(
      screen.findByRole('tab', { name: 'Tasks', selected: true }),
    ).resolves.toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Mimir' })).toBeDefined();
  });

  it('drops a tab value it does not know, and opens on Work', async () => {
    serveProject();
    const { router: testRouter } = await renderRoute(
      consoleRoutes,
      '/p/MMR?tab=timeline',
      quietClient(),
    );

    await expect(screen.findByRole('tab', { name: 'Work', selected: true })).resolves.toBeDefined();
    expect(testRouter.state.location.searchStr).toBe('');
  });

  it('an old /board link reads as no record rather than a board (MMR-487)', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR/board', quietClient());

    await expect(screen.findByText('No record at /p/MMR/board.')).resolves.toBeDefined();
  });

  it('makes New task its main action, filing into the project', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    const title = await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    const header = title.closest('header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: 'New task' }));
    await expect(screen.findByRole('dialog', { name: 'New work item' })).resolves.toBeDefined();
  });

  it('opens the project settings from Edit in More, and the direction from Edit direction…', async () => {
    serveProject();
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());

    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'Mimir' });
    expect(
      within(more)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['Edit', 'Edit direction…', 'Cancel']);
    await userEvent.click(within(more).getByRole('button', { name: 'Edit' }));
    await expect(screen.findByLabelText(/title/i)).resolves.toHaveValue('Mimir');
  });

  it('disables Edit, Edit direction…, and New task in its header while offline', async () => {
    serveProject();
    vi.mocked(list).mockRejectedValue(new TypeError('fetch failed'));
    await renderRoute(consoleRoutes, '/p/MMR/tasks', quietClient());

    await screen.findByText(/Offline/);
    const title = await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    const header = title.closest('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'New task' })).toBeDisabled();
    await userEvent.click(within(header).getByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'Mimir' });
    expect(within(more).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(more).getByRole('button', { name: 'Edit direction…' })).toBeDisabled();
  });

  it.each([
    ['/p/mmr', '/p/MMR', ''],
    ['/p/mmr/417?tab=timeline', '/p/MMR/417', '?tab=timeline'],
  ])('moves %s to its canonical spelling', async (url, pathname, search) => {
    serveProject();
    const { router: testRouter } = await renderRoute(consoleRoutes, url, quietClient());

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe(pathname);
    });
    expect(testRouter.state.location.searchStr).toBe(search);
  });
});

describe('a project change closes what its header opened (MMR-726)', () => {
  const mimir = engineProject({ id: 'MMR', next: 'Keep Mimir direction.', title: 'Mimir' });
  const norn = engineProject({ id: 'NRN', next: 'Keep Norn direction.', title: 'Norn' });

  /** Open Norn then Mimir, both cached, so Back shows Norn at once in the same frame. */
  async function onMimirAfterNorn() {
    serveShell({ projects: [mimir, norn] });
    serveNodes({ nodes: [mimir, norn] });
    const client = quietClient();
    client.setQueryData(projectQuery('MMR').queryKey, mimir);
    client.setQueryData(projectQuery('NRN').queryKey, norn);
    const { router: testRouter } = await renderRoute(consoleRoutes, '/p/NRN?tab=details', client);
    await act(async () => {
      await testRouter.navigate({
        params: { key: 'MMR' },
        search: { tab: 'details' },
        to: '/p/$key',
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    return testRouter;
  }

  async function goBackToNorn(testRouter: Awaited<ReturnType<typeof onMimirAfterNorn>>) {
    act(() => {
      testRouter.history.back();
    });
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/NRN');
    });
  }

  it('closes the Direction editor, so a Mimir draft never saves to Norn', async () => {
    const testRouter = await onMimirAfterNorn();
    const more = await screen.findByRole('dialog', { name: 'Mimir' });
    await userEvent.click(within(more).getByRole('button', { name: 'Edit direction…' }));
    const draft = await screen.findByRole('textbox', { name: 'Direction text' });
    await userEvent.clear(draft);
    await userEvent.type(draft, 'New Mimir direction.');

    await goBackToNorn(testRouter);

    expect(screen.queryByRole('textbox', { name: 'Direction text' })).toBeNull();
    expect(updateProject).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Norn' })).toBeDefined();
  });

  it('closes the project settings opened for Mimir', async () => {
    const testRouter = await onMimirAfterNorn();
    const more = await screen.findByRole('dialog', { name: 'Mimir' });
    await userEvent.click(within(more).getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog', { name: 'Project settings' });

    await goBackToNorn(testRouter);

    expect(screen.queryByRole('dialog', { name: 'Project settings' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Norn' })).toBeDefined();
  });
});
