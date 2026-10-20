import { MimirError } from '@mimir/contract';
import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifacts, list, seeds } from '../api/fns/browse';
import { projects } from '../api/fns/shell';
import { SeedCaptureProvider } from '../components/seed-capture';
import { readRememberedProject, rememberProject } from '../lib/current-project';
import {
  artifactsRoute,
  legacyArtifactsRoute,
  legacySeedsRoute,
  legacyTasksRoute,
  nodeRoute,
  projectRoute,
  reviewRoute,
  routeTree,
  seedsRoute,
  tasksRoute,
} from '../router';
import { taskSet } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { failShellReads, serveShell } from './shell-fns';
import { serveViews } from './views-fns';

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
}

const routes = [
  artifactsRoute,
  legacyArtifactsRoute,
  legacySeedsRoute,
  legacyTasksRoute,
  nodeRoute,
  projectRoute,
  reviewRoute,
  seedsRoute,
  tasksRoute,
];

const quietClient = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

const renderAt = (initial: string) =>
  renderRoute(routes, initial, quietClient(), SeedCaptureProvider);

function renderInShell(initial: string) {
  render(
    <QueryClientProvider client={quietClient()}>
      <RouterProvider
        router={createRouter({
          history: createMemoryHistory({ initialEntries: [initial] }),
          routeTree,
        })}
      />
    </QueryClientProvider>,
  );
}

/** Wait for the router to settle on `pathname`, then return its location. */
async function settledAt(
  testRouter: Awaited<ReturnType<typeof renderAt>>['router'],
  pathname: string,
) {
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
    const { router: testRouter } = await renderAt(`/p/NRN/${view}`);
    await expect(
      screen.findByRole('heading', { level: 1, name: heading }),
    ).resolves.toBeInTheDocument();
    expect(testRouter.state.location.pathname).toBe(`/p/NRN/${view}`);
  });

  it.each(['tasks', 'seeds', 'artifacts'])('/p/mmr/%s moves to the canonical key', async (view) => {
    const { router: testRouter } = await renderAt(`/p/mmr/${view}?q=wire`);
    const location = await settledAt(testRouter, `/p/MMR/${view}`);
    expect(location.search).toEqual({ q: 'wire' });
  });

  it('keeps typed filters on the scoped routes', async () => {
    const { router: testRouter } = await renderAt('/p/MMR/tasks?status=blocked&q=wire');
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    expect(testRouter.state.location.search).toEqual({
      q: 'wire',
      status: 'blocked',
    });
  });

  it('still routes record suffixes to record pages', async () => {
    const { router: testRouter } = await renderAt('/p/MMR/417');
    expect((await settledAt(testRouter, '/p/MMR/417')).pathname).toBe('/p/MMR/417');
    expect(screen.queryByRole('heading', { level: 1, name: 'Tasks' })).toBeNull();
  });
});

describe('a browser under an unknown project (MMR-495)', () => {
  it.each(['tasks', 'seeds', 'artifacts'])(
    '/p/ZZZ/%s shows the project-unavailable page, as /p/ZZZ does',
    async (view) => {
      await renderAt(`/p/ZZZ/${view}`);
      await expect(
        screen.findByRole('heading', { level: 1, name: 'Project unavailable' }),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByText(/Unreachable/)).toBeNull();
    },
  );
});

// Shell tests: the shell's project-list effect does the remembering, so these mount the full tree.
describe('remembering the current project (MMR-495)', () => {
  it('remembers the project of a page once the list confirms it exists', async () => {
    renderInShell('/p/NRN/tasks');
    await waitFor(() => {
      expect(readRememberedProject()).toBe('NRN');
    });
  });

  it('does not remember a key that names no project', async () => {
    rememberProject('MMR');
    renderInShell('/p/ZZZ/tasks');
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    await waitFor(() => {
      expect(projects).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'active' }) }),
      );
    });
    expect(readRememberedProject()).toBe('MMR');
  });

  it('does not remember the unknown project', async () => {
    renderInShell('/p/ZZZ/tasks');
    await screen.findByRole('heading', { level: 1, name: 'Project unavailable' });
    expect(readRememberedProject()).toBeUndefined();
  });
});

describe('the top-level browsers redirect (MMR-495)', () => {
  it.each(['tasks', 'seeds', 'artifacts'])(
    '/%s?project=K goes to the scoped route',
    async (view) => {
      const { router: testRouter } = await renderAt(`/${view}?project=NRN`);
      expect((await settledAt(testRouter, `/p/NRN/${view}`)).pathname).toBe(`/p/NRN/${view}`);
    },
  );

  it('keeps the other params on /tasks', async () => {
    const { router: testRouter } = await renderAt('/tasks?project=MMR&status=blocked&q=wire');
    const location = await settledAt(testRouter, '/p/MMR/tasks');
    expect(location.search).toEqual({ q: 'wire', status: 'blocked' });
  });

  it('keeps the other params on /seeds', async () => {
    const { router: testRouter } = await renderAt('/seeds?project=MMR&kind=bug&q=flicker');
    const location = await settledAt(testRouter, '/p/MMR/seeds');
    expect(location.search).toEqual({ kind: 'bug', q: 'flicker' });
  });

  it('keeps the other params on /artifacts', async () => {
    const { router: testRouter } = await renderAt(
      '/artifacts?project=MMR&tag=kind:spec&atOrAfter=2026-06-01',
    );
    const location = await settledAt(testRouter, '/p/MMR/artifacts');
    expect(location.search).toEqual({ atOrAfter: '2026-06-01', tag: 'kind:spec' });
  });

  it('accepts a lowercase project key', async () => {
    const { router: testRouter } = await renderAt('/tasks?project=nrn');
    expect((await settledAt(testRouter, '/p/NRN/tasks')).pathname).toBe('/p/NRN/tasks');
  });

  it.each(['tasks', 'seeds', 'artifacts'])(
    '/%s?project=all (any case) is the bare redirect, not a project named ALL',
    async (view) => {
      rememberProject('NRN');
      const { router: testRouter } = await renderAt(`/${view}?project=All`);
      const location = await settledAt(testRouter, `/p/NRN/${view}`);
      expect(location.pathname).toBe(`/p/NRN/${view}`);
      expect(location.search).toEqual({});
    },
  );

  it('treats a project value that is not a key as absent', async () => {
    rememberProject('NRN');
    const { router: testRouter } = await renderAt('/tasks?project=toolong&status=ready');
    const location = await settledAt(testRouter, '/p/NRN/tasks');
    expect(location.search).toEqual({ status: 'ready' });
  });

  it.each(['tasks', 'seeds', 'artifacts'])(
    'bare /%s goes to the remembered project',
    async (view) => {
      rememberProject('NRN');
      const { router: testRouter } = await renderAt(`/${view}`);
      expect((await settledAt(testRouter, `/p/NRN/${view}`)).pathname).toBe(`/p/NRN/${view}`);
    },
  );

  it('bare /tasks keeps its params on the way to the remembered project', async () => {
    rememberProject('NRN');
    const { router: testRouter } = await renderAt('/tasks?status=ready&q=wire');
    const location = await settledAt(testRouter, '/p/NRN/tasks');
    expect(location.search).toEqual({ q: 'wire', status: 'ready' });
  });

  it('bare with no history goes to the first project in switcher order', async () => {
    serve([MMR, { ...NRN, pinned: true }]);
    const { router: testRouter } = await renderAt('/seeds');
    expect((await settledAt(testRouter, '/p/NRN/seeds')).pathname).toBe('/p/NRN/seeds');
  });

  it('bare with a remembered project that is gone goes to the first project', async () => {
    rememberProject('GONE');
    const { router: testRouter } = await renderAt('/artifacts');
    expect((await settledAt(testRouter, '/p/MMR/artifacts')).pathname).toBe('/p/MMR/artifacts');
  });

  it('stays on the URL and says unreachable while the project list fails', async () => {
    failShellReads(new Error('connection refused'));
    const { router: testRouter } = await renderAt('/tasks?status=ready');
    await expect(screen.findByText(/Unreachable/)).resolves.toBeInTheDocument();
    expect(testRouter.state.location.pathname).toBe('/tasks');
    expect(testRouter.state.location.search).toEqual({ status: 'ready' });
  });

  it('with no projects at all, goes to the review page', async () => {
    serve([]);
    const { router: testRouter } = await renderAt('/tasks?status=ready');
    const location = await settledAt(testRouter, '/');
    expect(location.search).toEqual({});
  });
});
