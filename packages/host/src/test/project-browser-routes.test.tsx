import { MimirError } from '@mimir/contract';
import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifacts, list, seeds } from '../api/fns/browse';
import { projects } from '../api/fns/shell';
import { readRememberedProject, rememberProject } from '../lib/current-project';
import { routeTree } from '../router';
import { taskSet } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { failShellReads, serveShell } from './shell-fns';
import { serveViews } from './views-fns';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

const MMR = engineProject({ id: 'MMR' });
const NRN = engineProject({ id: 'NRN' });

/** A key that names no project: its browsers' reads and its record are refused as not found. */
function refuseUnknown(project: string) {
  if (project === 'ZZZ') {
    throw new MimirError('not_found', 'project ZZZ not found');
  }
}

/** Serve `active` as the project list and empty reads for everything else. */
function serve(active: EngineNode[]) {
  serveShell({ projects: active });
  serveNodes({ nodes: active });
  serveBrowse();
  vi.mocked(list).mockImplementation(async ({ data }) => {
    refuseUnknown(data.project);
    return taskSet([]);
  });
  vi.mocked(seeds).mockImplementation(async ({ data }) => {
    refuseUnknown(data.project);
    return [];
  });
  vi.mocked(artifacts).mockImplementation(async ({ data }) => {
    refuseUnknown(data.project);
    return { items: [], returned: 0, startsAt: 0, total: 0 };
  });
  apiGet.mockImplementation((path: string) => Promise.reject(new Error(`unexpected ${path}`)));
}

function renderAt(initial: string) {
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

/** Wait for the router to settle on `pathname`, then return its location. */
async function settledAt(testRouter: ReturnType<typeof renderAt>, pathname: string) {
  await waitFor(() => {
    expect(testRouter.state.location.pathname).toBe(pathname);
  });
  return testRouter.state.location;
}

beforeEach(() => {
  serveViews();
  localStorage.clear();
  serve([MMR, NRN]);
});

describe('the project browsers are routes under their project (MMR-495)', () => {
  it.each([
    ['tasks', 'Tasks'],
    ['seeds', 'Seeds'],
    ['artifacts', 'Artifacts'],
  ])('/p/KEY/%s renders its browser, not a record page', async (view, heading) => {
    const testRouter = renderAt(`/p/NRN/${view}`);
    await expect(
      screen.findByRole('heading', { level: 1, name: heading }),
    ).resolves.toBeInTheDocument();
    expect(testRouter.state.location.pathname).toBe(`/p/NRN/${view}`);
  });

  it.each(['tasks', 'seeds', 'artifacts'])('/p/mmr/%s moves to the canonical key', async (view) => {
    const testRouter = renderAt(`/p/mmr/${view}?q=wire`);
    const location = await settledAt(testRouter, `/p/MMR/${view}`);
    expect(location.search).toEqual({ q: 'wire' });
  });

  it('keeps typed filters on the scoped routes', async () => {
    const testRouter = renderAt('/p/MMR/tasks?status=blocked&q=wire');
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    expect(testRouter.state.location.search).toEqual({
      q: 'wire',
      status: 'blocked',
    });
  });

  it('still routes record suffixes to record pages', async () => {
    const testRouter = renderAt('/p/MMR/417');
    expect((await settledAt(testRouter, '/p/MMR/417')).pathname).toBe('/p/MMR/417');
    expect(screen.queryByRole('heading', { level: 1, name: 'Tasks' })).toBeNull();
  });
});

describe('a browser under an unknown project (MMR-495)', () => {
  it.each(['tasks', 'seeds', 'artifacts'])(
    '/p/ZZZ/%s shows the project-unavailable page, as /p/ZZZ does',
    async (view) => {
      renderAt(`/p/ZZZ/${view}`);
      await expect(
        screen.findByRole('heading', { level: 1, name: 'Project unavailable' }),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByText(/Unreachable/)).toBeNull();
    },
  );

  it('does not remember the unknown project', async () => {
    renderAt('/p/ZZZ/tasks');
    await screen.findByRole('heading', { level: 1, name: 'Project unavailable' });
    expect(readRememberedProject()).toBeUndefined();
  });
});

describe('remembering the current project (MMR-495)', () => {
  it('remembers the project of a page once the list confirms it exists', async () => {
    renderAt('/p/NRN/tasks');
    await waitFor(() => {
      expect(readRememberedProject()).toBe('NRN');
    });
  });

  it('does not remember a key that names no project', async () => {
    rememberProject('MMR');
    renderAt('/p/ZZZ/tasks');
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    await waitFor(() => {
      expect(projects).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'active' }) }),
      );
    });
    expect(readRememberedProject()).toBe('MMR');
  });
});

describe('the top-level browsers redirect (MMR-495)', () => {
  it.each(['tasks', 'seeds', 'artifacts'])(
    '/%s?project=K goes to the scoped route',
    async (view) => {
      const testRouter = renderAt(`/${view}?project=NRN`);
      expect((await settledAt(testRouter, `/p/NRN/${view}`)).pathname).toBe(`/p/NRN/${view}`);
    },
  );

  it('keeps the other params on /tasks', async () => {
    const testRouter = renderAt('/tasks?project=MMR&status=blocked&q=wire');
    const location = await settledAt(testRouter, '/p/MMR/tasks');
    expect(location.search).toEqual({ q: 'wire', status: 'blocked' });
  });

  it('keeps the other params on /seeds', async () => {
    const testRouter = renderAt('/seeds?project=MMR&kind=bug&q=flicker');
    const location = await settledAt(testRouter, '/p/MMR/seeds');
    expect(location.search).toEqual({ kind: 'bug', q: 'flicker' });
  });

  it('keeps the other params on /artifacts', async () => {
    const testRouter = renderAt('/artifacts?project=MMR&tag=kind:spec&atOrAfter=2026-06-01');
    const location = await settledAt(testRouter, '/p/MMR/artifacts');
    expect(location.search).toEqual({ atOrAfter: '2026-06-01', tag: 'kind:spec' });
  });

  it('accepts a lowercase project key', async () => {
    const testRouter = renderAt('/tasks?project=nrn');
    expect((await settledAt(testRouter, '/p/NRN/tasks')).pathname).toBe('/p/NRN/tasks');
  });

  it.each(['tasks', 'seeds', 'artifacts'])(
    '/%s?project=all (any case) is the bare redirect, not a project named ALL',
    async (view) => {
      rememberProject('NRN');
      const testRouter = renderAt(`/${view}?project=All`);
      const location = await settledAt(testRouter, `/p/NRN/${view}`);
      expect(location.pathname).toBe(`/p/NRN/${view}`);
      expect(location.search).toEqual({});
    },
  );

  it('treats a project value that is not a key as absent', async () => {
    rememberProject('NRN');
    const testRouter = renderAt('/tasks?project=toolong&status=ready');
    const location = await settledAt(testRouter, '/p/NRN/tasks');
    expect(location.search).toEqual({ status: 'ready' });
  });

  it.each(['tasks', 'seeds', 'artifacts'])(
    'bare /%s goes to the remembered project',
    async (view) => {
      rememberProject('NRN');
      const testRouter = renderAt(`/${view}`);
      expect((await settledAt(testRouter, `/p/NRN/${view}`)).pathname).toBe(`/p/NRN/${view}`);
    },
  );

  it('bare /tasks keeps its params on the way to the remembered project', async () => {
    rememberProject('NRN');
    const testRouter = renderAt('/tasks?status=ready&q=wire');
    const location = await settledAt(testRouter, '/p/NRN/tasks');
    expect(location.search).toEqual({ q: 'wire', status: 'ready' });
  });

  it('bare with no history goes to the first project in switcher order', async () => {
    serve([MMR, { ...NRN, pinned: true }]);
    const testRouter = renderAt('/seeds');
    expect((await settledAt(testRouter, '/p/NRN/seeds')).pathname).toBe('/p/NRN/seeds');
  });

  it('bare with a remembered project that is gone goes to the first project', async () => {
    rememberProject('GONE');
    const testRouter = renderAt('/artifacts');
    expect((await settledAt(testRouter, '/p/MMR/artifacts')).pathname).toBe('/p/MMR/artifacts');
  });

  it('stays on the URL and says unreachable while the project list fails', async () => {
    apiGet.mockRejectedValue(new Error('connection refused'));
    failShellReads(new Error('connection refused'));
    const testRouter = renderAt('/tasks?status=ready');
    await expect(screen.findByText(/Unreachable/)).resolves.toBeInTheDocument();
    expect(testRouter.state.location.pathname).toBe('/tasks');
    expect(testRouter.state.location.search).toEqual({ status: 'ready' });
  });

  it('with no projects at all, goes to the review page', async () => {
    serve([]);
    const testRouter = renderAt('/tasks?status=ready');
    const location = await settledAt(testRouter, '/');
    expect(location.search).toEqual({});
  });
});
