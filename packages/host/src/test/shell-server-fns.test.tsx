import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { consoleSearch, projects, tree } from '../api/fns/shell';
import { review } from '../api/fns/views';
import { Shell } from '../routes/shell';
import { engineProject, engineTree, searchHit } from './engine-fixtures';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');

/*
 * The shell runs on server functions (MMR-537): its project lists, sidebar
 * tree, and palette search reach the Engine, and its version reads the host's
 * /health. The review report behind the attention alert and the switcher's
 * decision counts reach the Engine too (MMR-538). The pages are stubs: only
 * the chrome around them is under test.
 */
vi.mock('../api/health', () => ({
  fetchHealth: async () => ({
    minClient: '0.26.0-next',
    schema: 1,
    status: 'ok',
    version: 'host-build',
  }),
}));

beforeEach(() => {
  serveViews();
  stubViewport('desktop');
  localStorage.clear();
  serveShell({
    archived: [engineProject({ archivedAt: new Date('2026-05-01T00:00:00.000Z'), id: 'OLD' })],
    hits: [searchHit({ id: 'MMR-3', title: 'Outline the console' })],
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
        engineTree({ id: 'MMR-1', status: 'in_progress', title: 'Console', type: 'initiative' }),
      ]),
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A page that reads nothing, so only the shell around it asks for data. */
const StubPage = () => <main>page</main>;

/** The shell around stub pages, at `path`. */
function renderShell(path: string) {
  const root = createRootRoute({ component: Shell });
  const routeTree = root.addChildren([
    createRoute({ component: StubPage, getParentRoute: () => root, path: '/' }),
    createRoute({ component: StubPage, getParentRoute: () => root, path: '/p/$key' }),
  ]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree,
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('the shell on server functions (MMR-537)', () => {
  it('reads its projects, tree, search, and version', async () => {
    const user = userEvent.setup();
    renderShell('/p/MMR');

    // The sidebar's outline comes from the tree; the switcher lists both shelves.
    await expect(screen.findByRole('link', { name: /Console/ })).resolves.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^MMR/ }));
    const listbox = await screen.findByRole('listbox', { name: 'Projects' });
    expect(within(listbox).getByRole('option', { name: /MMR/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // The palette searches across every project, the current one ranked first.
    await user.click(screen.getByRole('button', { name: 'Jump to…' }));
    await user.type(
      await screen.findByRole('combobox', { name: 'Jump to a record or action' }),
      'outline',
    );
    await expect(
      screen.findByRole('option', { name: /Outline the console/ }),
    ).resolves.toBeInTheDocument();

    // The footer reads the host's build from /health.
    await waitFor(() => {
      expect(screen.getByTestId('console-version')).toHaveTextContent('host-build');
    });

    expect(projects).toHaveBeenCalledWith({
      data: { facets: ['distribution', 'tags'], status: 'active' },
    });
    expect(projects).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'archived' }),
    });
    expect(tree).toHaveBeenCalledWith({ data: { id: 'MMR' } });
    expect(review).toHaveBeenCalledWith({ data: { timeZone: expect.any(String) } });
    expect(consoleSearch).toHaveBeenCalledWith({ data: { project: 'MMR', query: 'outline' } });
  });
});
