import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireNode } from '../api/types';
import { readRememberedProject, rememberProject } from '../lib/current-project';
import { router } from '../router';
import { emptyRead, project } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));

const MMR = project({ id: 'MMR' });
const NRN = project({ id: 'NRN' });

/** Serve `projects` as the project list and empty reads for everything else. */
function serve(projects: WireNode[]) {
  apiGet.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/api/projects' ? { items: projects, total: projects.length } : emptyRead(path),
    ),
  );
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

/** Wait for the router to settle on `pathname`, then return its location. */
async function settledAt(testRouter: ReturnType<typeof renderAt>, pathname: string) {
  await waitFor(() => {
    expect(testRouter.state.location.pathname).toBe(pathname);
  });
  return testRouter.state.location;
}

beforeEach(() => {
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
    const testRouter = renderAt('/p/MMR/tasks?status=blocked&group=project');
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    expect(testRouter.state.location.search).toEqual({
      group: 'project',
      status: 'blocked',
    });
  });

  it('still routes record suffixes to record pages', async () => {
    const testRouter = renderAt('/p/MMR/417');
    expect((await settledAt(testRouter, '/p/MMR/417')).pathname).toBe('/p/MMR/417');
    expect(screen.queryByRole('heading', { level: 1, name: 'Tasks' })).toBeNull();
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
      expect(apiGet).toHaveBeenCalledWith('/api/projects');
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
    const testRouter = renderAt('/tasks?project=MMR&status=blocked&q=wire&group=project');
    const location = await settledAt(testRouter, '/p/MMR/tasks');
    expect(location.search).toEqual({ group: 'project', q: 'wire', status: 'blocked' });
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
    serve([MMR, { ...NRN, pinned: true } as WireNode]);
    const testRouter = renderAt('/seeds');
    expect((await settledAt(testRouter, '/p/NRN/seeds')).pathname).toBe('/p/NRN/seeds');
  });

  it('bare with a remembered project that is gone goes to the first project', async () => {
    rememberProject('GONE');
    const testRouter = renderAt('/artifacts');
    expect((await settledAt(testRouter, '/p/MMR/artifacts')).pathname).toBe('/p/MMR/artifacts');
  });

  it('with no projects at all, goes to the review page', async () => {
    serve([]);
    const testRouter = renderAt('/tasks?status=ready');
    const location = await settledAt(testRouter, '/');
    expect(location.search).toEqual({});
  });
});
