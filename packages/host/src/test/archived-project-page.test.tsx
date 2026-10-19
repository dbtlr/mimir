import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNode } from '../api/fns/nodes';
import { projects, unarchive } from '../api/fns/shell';
import { createQueryClient } from '../api/query-client';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

const OLD = engineProject({
  archivedAt: new Date('2026-09-30T15:00:00.000Z'),
  id: 'OLD',
  status: 'done',
  title: 'Old project',
});

/**
 * `OLD` is archived until unarchived, so its record is not found and the archived list names it;
 * `ZZZ` is unknown. The Engine's record read refuses both the same way.
 */
function serve() {
  const shell = serveShell({ archived: [OLD] });
  const records = serveNodes({ nodes: [] });
  vi.mocked(unarchive).mockImplementation(async () => {
    shell.archived = [];
    records.nodes = [engineProject({ id: 'OLD', status: 'in_progress', title: 'Old project' })];
    return engineProject({ id: 'OLD' });
  });
}

/** How many reads of the archived project's own record the page has made. */
const projectReads = () =>
  vi.mocked(getNode).mock.calls.filter(([options]) => options.data.id === 'OLD').length;

const quietClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

function renderAt(initial: string, client = quietClient()) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

beforeEach(() => {
  serveBrowse();
  serveViews();
  vi.mocked(getNode).mockReset();
  vi.mocked(projects).mockReset();
  vi.mocked(unarchive).mockReset();
  serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an archived project’s address (MMR-506)', () => {
  it('says the project is archived, with its name and date, and offers Unarchive', async () => {
    renderAt('/p/OLD');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Old project' }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText('OLD')).toBeInTheDocument();
    expect(screen.getByText(/Archived/)).toBeInTheDocument();
    expect(screen.getByText(/❄ 2026-09-30/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unarchive Old project' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Project unavailable' })).toBeNull();
  });

  it('says what archiving hid without naming the retired board', async () => {
    renderAt('/p/OLD');

    const notice = await screen.findByText(/This project is frozen/);
    expect(notice).toHaveTextContent('switcher’s active list');
    expect(notice).toHaveTextContent('review page');
    expect(notice).not.toHaveTextContent('board');
  });

  it('says so under its browsers too', async () => {
    renderAt('/p/OLD/tasks');

    await expect(
      screen.findByRole('button', { name: 'Unarchive Old project' }),
    ).resolves.toBeInTheDocument();
  });

  it('unarchives and lands on the project’s work page', async () => {
    const testRouter = renderAt('/p/OLD/tasks');

    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive Old project' }));

    await waitFor(() => {
      expect(unarchive).toHaveBeenCalledWith({ data: { id: 'OLD' } });
    });
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/OLD');
    });
    await expect(
      screen.findByRole('heading', { level: 1, name: 'Old project' }),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Unarchive/ })).toBeNull();
    });
  });

  it('keeps Unarchive disabled until the archived list is fresh, so it cannot be sent twice', async () => {
    const refetch = Promise.withResolvers<EngineNode[]>();
    const served = vi.mocked(projects).getMockImplementation();
    const send = vi.mocked(unarchive).getMockImplementation();
    vi.mocked(unarchive).mockImplementation(async (...args) => {
      // The write lands, but the archived list's refetch is still in flight.
      vi.mocked(projects).mockReturnValue(refetch.promise);
      return send?.(...args) as Promise<EngineNode>;
    });
    const testRouter = renderAt('/p/OLD/tasks');

    const button = await screen.findByRole('button', { name: 'Unarchive Old project' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(unarchive).toHaveBeenCalledTimes(1);
    });
    expect(button).toBeDisabled();
    expect(testRouter.state.location.pathname).toBe('/p/OLD/tasks');

    fireEvent.click(button);
    expect(unarchive).toHaveBeenCalledTimes(1);

    if (served !== undefined) {
      vi.mocked(projects).mockImplementation(served);
    }
    refetch.resolve([]);
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/OLD');
    });
  });

  it('stays still across poll intervals: no further project reads, and the notice never unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/p/OLD', createQueryClient());
    const button = await screen.findByRole('button', { name: 'Unarchive Old project' });
    const removed: Node[] = [];
    const watch = new MutationObserver((records) => {
      removed.push(...records.flatMap((r) => [...r.removedNodes]));
    });
    watch.observe(document.body, { childList: true, subtree: true });
    // Let any first-load retry settle, then count the reads from here on.
    await vi.advanceTimersByTimeAsync(5000);
    const before = projectReads();

    await vi.advanceTimersByTimeAsync(35_000);
    watch.disconnect();

    expect(projectReads()).toBe(before);
    expect(button.isConnected).toBe(true);
    expect(removed.some((node) => node.contains(button))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Project unavailable' })).toBeNull();
  });

  it('keeps the unavailable page for a key that names no project', async () => {
    renderAt('/p/ZZZ');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Project unavailable' }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Unarchive/ })).toBeNull();
  });
});
