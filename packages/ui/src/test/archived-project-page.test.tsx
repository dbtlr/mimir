import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { createQueryClient } from '../api/query-client';
import { router } from '../router';
import { emptyRead, project, workReport } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

const OLD = project({
  archived_at: '2026-09-30T15:00:00.000Z',
  id: 'OLD',
  status: 'done',
  title: 'Old project',
});

const names = (path: string, key: string) =>
  path.startsWith(`/api/projects/${key}`) || new RegExp(`[?&]project=${key}`).test(path);
const notFound = (path: string) => Promise.reject(new ApiError(`GET ${path} → 404`, 404));

/** `OLD` is archived until unarchived, so its record 404s and the archived list names it; `ZZZ` is unknown. */
function serve() {
  let archived = true;
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/projects?status=archived') {
      return Promise.resolve({ items: archived ? [OLD] : [], total: archived ? 1 : 0 });
    }
    if (names(path, 'ZZZ') || (archived && names(path, 'OLD'))) {
      return notFound(path);
    }
    if (path === '/api/projects/OLD') {
      return Promise.resolve({ ...OLD, archived_at: null, status: 'in_progress' });
    }
    if (/\/work\b/.test(path)) {
      return Promise.resolve(workReport());
    }
    return Promise.resolve(emptyRead(path));
  });
  apiSend.mockImplementation(() => {
    archived = false;
    return Promise.resolve({});
  });
}

/** How many reads of the archived project's own routes the page has made. */
const projectReads = () =>
  apiGet.mock.calls.filter(([path]) => String(path).startsWith('/api/projects/OLD')).length;

const quietClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

function renderAt(initial: string, client = quietClient()) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
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
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/OLD/unarchive', undefined);
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
    const refetch = Promise.withResolvers<unknown>();
    const served = apiGet.getMockImplementation();
    apiSend.mockImplementation(() => {
      // The write lands, but the archived list's refetch is still in flight.
      apiGet.mockImplementation((path: string) =>
        path === '/api/projects?status=archived' ? refetch.promise : served?.(path),
      );
      return Promise.resolve({});
    });
    const testRouter = renderAt('/p/OLD/tasks');

    const button = await screen.findByRole('button', { name: 'Unarchive Old project' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledTimes(1);
    });
    expect(button).toBeDisabled();
    expect(testRouter.state.location.pathname).toBe('/p/OLD/tasks');

    fireEvent.click(button);
    expect(apiSend).toHaveBeenCalledTimes(1);

    apiGet.mockImplementation((path: string) =>
      path === '/api/projects?status=archived'
        ? Promise.resolve({ items: [], total: 0 })
        : path === '/api/projects/OLD'
          ? Promise.resolve({ ...OLD, archived_at: null, status: 'in_progress' })
          : /\/work\b/.test(path)
            ? Promise.resolve(workReport())
            : Promise.resolve(emptyRead(path)),
    );
    refetch.resolve({ items: [], total: 0 });
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/OLD');
    });
  });

  it('stays still across poll intervals: no further project reads, and the notice never unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/p/OLD', createQueryClient());
    const unarchive = await screen.findByRole('button', { name: 'Unarchive Old project' });
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
    expect(unarchive.isConnected).toBe(true);
    expect(removed.some((node) => node.contains(unarchive))).toBe(false);
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
