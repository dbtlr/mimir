import type { EngineSearchHit } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleSearch } from '../api/fns/shell';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree, searchHit, searchSet } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

/** What the search answers, by query. */
const RESULTS: Record<string, EngineSearchHit[]> = {
  'MMR-417': [
    searchHit({ id: 'MMR-417', match: 'id', title: 'Add the SQLite dialect' }),
    searchHit({
      id: 'MMR-414',
      kind: 'phase',
      link: 'parent',
      match: 'link',
      title: 'SQLite replaces Norn',
    }),
    searchHit({
      id: 'MMR-a219',
      kind: 'artifact',
      lifecycle: null,
      link: 'artifact',
      match: 'link',
      title: 'Session summary',
    }),
  ],
  dialect: [
    searchHit({ id: 'MMR-417', title: 'Add the SQLite dialect' }),
    searchHit({
      id: 'MMR-418',
      match: 'description',
      snippet: 'once the dialect seam lands, drop the vault store',
      title: 'Remove the Norn backend',
    }),
  ],
  norn: [searchHit({ id: 'MMR-500', title: 'Retire Norn' })],
  sqlite: [
    searchHit({ id: 'MMR-417', title: 'Add the SQLite dialect' }),
    searchHit({ id: 'MMR-s41', kind: 'seed', lifecycle: 'new', title: 'SQLite locks under load' }),
  ],
};

function mockApi() {
  serveShell({
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }),
    },
  });
  vi.mocked(consoleSearch).mockImplementation(async ({ data }) =>
    searchSet(RESULTS[data.query] ?? []),
  );
  // An id no record has (ZZ-…) answers not found.
  serveNodes({
    nodes: [
      engineProject({ id: 'MMR', title: 'Mimir' }),
      engineTask({ id: 'MMR-417', status: 'ready', title: 'Add the SQLite dialect' }),
    ],
  });
}

function renderApp(initial = '/') {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree,
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

/** Open the palette with the keyboard and type a query into it. */
async function jump(user: ReturnType<typeof userEvent.setup>, query: string) {
  await screen.findByRole('button', { name: 'Jump to…' });
  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Jump to a record or action' });
  await user.type(input, query);
  return input;
}

/** Open the palette from the top-bar button, once its input has focus. */
async function openFromButton(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Jump to…' }));
  const input = await screen.findByRole('combobox', { name: 'Jump to a record or action' });
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  return input;
}

beforeEach(() => {
  serveBrowse();
  serveViews();
  localStorage.clear();
  mockApi();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('jump palette (MMR-455)', () => {
  it('finds a record by its exact ID, lists its links, and opens it with Enter', async () => {
    const user = userEvent.setup();
    const testRouter = renderApp('/p/MMR/tasks');

    await jump(user, 'MMR-417');

    const record = await screen.findByRole('group', { name: /Record/ });
    expect(within(record).getByRole('option', { name: /MMR-417/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const linked = screen.getByRole('group', { name: /Linked/ });
    expect(within(linked).getByRole('option', { name: /MMR-414/ })).toHaveTextContent('parent');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
    });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('groups title hits and moves through them with the arrow keys', async () => {
    const user = userEvent.setup();
    const testRouter = renderApp();

    await jump(user, 'sqlite');

    const titles = await screen.findByRole('group', { name: /Titles · 2/ });
    expect(
      within(titles)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toStrictEqual([expect.stringContaining('MMR-417'), expect.stringContaining('MMR-s41')]);

    await user.keyboard('{ArrowDown}');
    expect(within(titles).getByRole('option', { name: /MMR-s41/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Enter}');

    // A seed opens at its own page (MMR-451).
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/s41');
    });
  });

  it('shows a description hit under its own group, with the matched words', async () => {
    const user = userEvent.setup();
    renderApp();

    await jump(user, 'dialect');

    const descriptions = await screen.findByRole('group', { name: /Descriptions · 1/ });
    const row = within(descriptions).getByRole('option', { name: /MMR-418/ });
    expect(row).toHaveTextContent('Remove the Norn backend');
    expect(row).toHaveTextContent('once the dialect seam lands');
    expect(screen.getByRole('group', { name: /Titles · 1/ })).toBeInTheDocument();
  });

  it('ranks the current project first by sending it with the query', async () => {
    const user = userEvent.setup();
    renderApp('/p/MMR');

    await jump(user, 'sqlite');

    await screen.findByRole('group', { name: /Titles/ });
    expect(consoleSearch).toHaveBeenCalledWith({ data: { project: 'MMR', query: 'sqlite' } });
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderApp();

    await jump(user, 'zzz');

    await expect(screen.findByText(/No records match/)).resolves.toBeInTheDocument();
  });

  it('opens from the top-bar button and closes on Escape', async () => {
    const user = userEvent.setup();
    renderApp();

    await openFromButton(user);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Jump to…' })).toHaveFocus();
    });
  });

  it('opens the result for what is typed now, not for the query before it', async () => {
    const user = userEvent.setup();
    const testRouter = renderApp();

    const input = await jump(user, 'sqlite');
    await screen.findByRole('group', { name: /Titles · 2/ });
    await user.clear(input);
    // Enter lands before the new search has answered; it waits for it.
    await user.type(input, 'norn{Enter}');

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/500');
    });
  });

  it('ignores a click on a row left over from the previous query', async () => {
    const user = userEvent.setup();
    const testRouter = renderApp();

    const input = await jump(user, 'sqlite');
    await screen.findByRole('option', { name: /MMR-s41/ });
    // Typing over the query keeps the old rows on screen until the new search lands.
    await user.type(input, 'norn', { initialSelectionEnd: 6, initialSelectionStart: 0 });
    await user.click(screen.getByRole('option', { name: /MMR-s41/ }));

    await screen.findByRole('option', { name: /MMR-500/ });
    expect(testRouter.state.location.pathname).toBe('/');
  });

  it('searches every project from a page whose project does not exist', async () => {
    const user = userEvent.setup();
    renderApp('/p/ZZ/417');

    await screen.findByText(/No record ZZ-417/);
    await jump(user, 'sqlite');

    await screen.findByRole('group', { name: /Titles/ });
    expect(consoleSearch).toHaveBeenCalledWith({ data: { query: 'sqlite' } });
    expect(consoleSearch).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ project: 'ZZ' }),
    });
  });

  it('leaves ⌘K alone off a Mac, where the chord is Ctrl-K', async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole('button', { name: 'Jump to…' });
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('lists recently opened records and the actions when the query is empty', async () => {
    const user = userEvent.setup();
    const testRouter = renderApp('/p/MMR');

    await jump(user, 'sqlite');
    await screen.findByRole('group', { name: /Titles/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
    });

    await user.keyboard('{Control>}k{/Control}');
    const recent = await screen.findByRole('group', { name: /Recent/ });
    expect(within(recent).getByRole('option', { name: /MMR-417/ })).toBeInTheDocument();
    const actions = screen.getByRole('group', { name: /Actions/ });
    expect(within(actions).getByRole('option', { name: /New task in MMR/ })).toBeInTheDocument();
    expect(within(actions).getByRole('option', { name: /File a seed/ })).toBeInTheDocument();
  });

  it('counts a record page opened by its URL as recent', async () => {
    const user = userEvent.setup();
    renderApp('/p/MMR/417');

    await screen.findByRole('heading', { name: 'Add the SQLite dialect' });
    await user.click(screen.getByRole('button', { name: 'Jump to…' }));
    const recent = await screen.findByRole('group', { name: /Recent/ });
    expect(within(recent).getByRole('option', { name: /MMR-417/ })).toBeInTheDocument();
  });

  it('names no project on New task where none is in scope', async () => {
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Jump to…' }));
    const actions = await screen.findByRole('group', { name: /Actions/ });
    expect(within(actions).getByRole('option', { name: 'New task' })).toBeInTheDocument();
  });

  it('runs an action from the keyboard: File a seed opens the capture dialog', async () => {
    const user = userEvent.setup();
    renderApp('/p/MMR/tasks');

    await openFromButton(user);
    const actions = screen.getByRole('group', { name: /Actions/ });
    // Recent is empty, so the options start at the actions: New task, then File a seed.
    expect(within(actions).getAllByRole('option')[1]).toHaveTextContent('File a seed');
    await user.keyboard('{ArrowDown}{Enter}');

    await screen.findByLabelText('Seed');
    await waitFor(() => {
      expect(screen.getByLabelText('Seed')).toHaveFocus();
    });
    expect(
      screen.queryByRole('combobox', { name: 'Jump to a record or action' }),
    ).not.toBeInTheDocument();
  });

  it('opens the authoring sheet from New task', async () => {
    const user = userEvent.setup();
    renderApp('/p/MMR');

    await user.click(await screen.findByRole('button', { name: 'Jump to…' }));
    await user.click(await screen.findByRole('option', { name: /New task in MMR/ }));

    await expect(screen.findByRole('textbox', { name: /title/i })).resolves.toBeInTheDocument();
  });
});
