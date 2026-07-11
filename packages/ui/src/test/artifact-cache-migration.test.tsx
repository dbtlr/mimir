import { QueryClient, QueryClientProvider, dehydrate, hydrate } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { sanitizePersistedClient } from '../lib/persist';
import { router } from '../router';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet }));

// A pre-infinite payload: the flat `{ items, total }` collection the artifacts
// query persisted while it was a plain `useQuery`, before b0755d7 made it
// infinite. Restoring it into the new `useInfiniteQuery` crashes react-query's
// `hasNextPage` (`pages.length` on `undefined`) unless the guard drops it.
const flatArtifacts = {
  items: [
    {
      created_at: '2026-06-01T00:00:00.000Z',
      id: 'MMR-old',
      project: 'MMR',
      tags: [],
      title: 'Stale cached artifact',
    },
  ],
  total: 1,
};

type DehydratedQuery = PersistedClient['clientState']['queries'][number];

function persistedWith(queries: DehydratedQuery[]): PersistedClient {
  return { buster: 'mimir-ui-v2', clientState: { mutations: [], queries }, timestamp: Date.now() };
}

// sanitize reads only queryKey + state.data, so a minimal entry suffices.
const entry = (queryKey: unknown[], data: unknown): DehydratedQuery =>
  ({
    queryHash: JSON.stringify(queryKey),
    queryKey,
    state: { data },
  }) as unknown as DehydratedQuery;

describe('sanitizePersistedClient', () => {
  it('drops a legacy flat-collection payload under an infinite query key', () => {
    const out = sanitizePersistedClient(persistedWith([entry(['artifacts', {}], flatArtifacts)]));
    expect(out.clientState.queries).toHaveLength(0);
  });

  it('keeps a properly infinite-shaped artifacts entry', () => {
    const infinite = { pageParams: [0], pages: [flatArtifacts] };
    const out = sanitizePersistedClient(persistedWith([entry(['artifacts', {}], infinite)]));
    expect(out.clientState.queries).toHaveLength(1);
  });

  it('leaves non-infinite queries untouched', () => {
    const out = sanitizePersistedClient(
      persistedWith([entry(['projects'], { items: [], total: 0 })]),
    );
    expect(out.clientState.queries).toHaveLength(1);
  });
});

function renderArtifactsWith(client: QueryClient) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: ['/artifacts'] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe('artifacts route rehydrating a legacy warm cache', () => {
  it('degrades to a clean refetch instead of crashing the route', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/projects')) {
        return Promise.resolve({ items: [], total: 0 });
      }
      if (path.startsWith('/api/artifacts?')) {
        return Promise.resolve({
          items: [
            {
              created_at: '2026-06-16T00:00:00.000Z',
              id: 'MMR-new',
              project: 'MMR',
              tags: [],
              title: 'Fresh artifact',
            },
          ],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    // A warm cache from the pre-infinite build: a plain query holding the flat
    // collection, dehydrated exactly as the persister would have stored it.
    const warm = new QueryClient();
    warm.setQueryData(['artifacts', {}], flatArtifacts);
    const persisted = persistedWith(dehydrate(warm).queries);

    // The restore path: the persister deserializes + guards before hydrate.
    const client = new QueryClient();
    hydrate(client, sanitizePersistedClient(persisted).clientState);

    renderArtifactsWith(client);

    // No crash: the route mounts and the fresh refetch renders.
    await expect(screen.findByText('Fresh artifact')).resolves.toBeDefined();
    // The stale-shape row was dropped, never rendered.
    expect(screen.queryByText('Stale cached artifact')).toBeNull();
  });
});
