import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
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

function renderAt(initial: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: router.routeTree,
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

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
  serve();
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

  it('keeps the unavailable page for a key that names no project', async () => {
    renderAt('/p/ZZZ');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Project unavailable' }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Unarchive/ })).toBeNull();
  });
});
