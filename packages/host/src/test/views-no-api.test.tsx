import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeWork, projectWork, review } from '../api/fns/views';
import { WorkPage } from '../components/work-page';
import { routeTree } from '../router';
import { engineProject } from './engine-fixtures';
import { task } from './fixtures';
import { renderInRouter } from './router';
import { serveShell } from './shell-fns';
import { engineReview, engineWork, needsYouRow, nowRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');

/*
 * The review page and the work pages run on server functions (MMR-538): the
 * review report and the project and container work reads reach the Engine,
 * and none of it asks /api. The real fetch is stubbed, so any /api request is
 * recorded rather than mocked away. A work page's own record and rail reads
 * move with the record pages, so the work pages render here from a record in
 * hand, as the route does once its record has loaded.
 */

let requested: string[];

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      requested.push(url.pathname);
      return Response.json({ error: { message: 'not served' } }, { status: 503 });
    }),
  );
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveViews({
    nodes: {
      'MMR-105': engineWork({
        needsYou: [needsYouRow({ id: 'MMR-12', status: 'under_review' }, 'under_review')],
        scope: { id: 'MMR-105', kind: 'phase', title: 'Work page' },
      }),
    },
    projects: {
      MMR: engineWork({ now: [nowRow({ id: 'MMR-11', title: 'Wire the dialect' })] }),
    },
    review: engineReview({
      decisions: [
        {
          project: { key: 'MMR', name: 'Mimir' },
          rows: [needsYouRow({ id: 'MMR-12', status: 'under_review' }, 'under_review')],
        },
      ],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { decisions: 1 })],
      queue: ['MMR-12'],
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const client = () =>
  new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } });

describe('the review and work pages on server functions (MMR-538)', () => {
  it('reads the review page, its rail, and the alert without asking /api', async () => {
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree,
    });
    render(
      <QueryClientProvider client={client()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await expect(
      screen.findByRole('heading', { level: 1, name: /Needs you/ }),
    ).resolves.toBeInTheDocument();
    expect(review).toHaveBeenCalledWith({ data: { timeZone: expect.any(String) } });
    expect(requested.filter((path) => path.startsWith('/api'))).toStrictEqual([]);
  });

  it('reads a project work page without asking /api', async () => {
    const record = {
      ...task({ id: 'MMR', status: 'in_progress', title: 'Mimir' }),
      type: 'project' as const,
    };
    await renderInRouter(<WorkPage record={record} offline={false} />, client());

    await expect(screen.findByRole('region', { name: 'Now · 1' })).resolves.toBeInTheDocument();
    expect(projectWork).toHaveBeenCalledWith({
      data: { project: 'MMR', timeZone: expect.any(String) },
    });
    expect(requested.filter((path) => path.startsWith('/api'))).toStrictEqual([]);
  });

  it('reads a container work page without asking /api', async () => {
    const record = task({
      id: 'MMR-105',
      status: 'in_progress',
      title: 'Work page',
      type: 'phase',
    });
    await renderInRouter(
      <WorkPage
        record={record}
        offline={false}
        container={{ onTab: () => {}, tab: 'work', timeline: null, timelineCount: 0 }}
      />,
      client(),
    );

    await expect(
      screen.findByRole('region', { name: 'Needs you · 1' }),
    ).resolves.toBeInTheDocument();
    expect(nodeWork).toHaveBeenCalledWith({
      data: { id: 'MMR-105', timeZone: expect.any(String) },
    });
    expect(requested.filter((path) => path.startsWith('/api'))).toStrictEqual([]);
  });
});
