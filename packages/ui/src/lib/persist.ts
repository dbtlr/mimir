import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

import { INFINITE_QUERY_KEY_ROOTS } from '../api/queries';

/**
 * The query cache persisted to IndexedDB (ADR 0013 §5) — the substrate of the
 * offline read. localStorage is too small for board payloads; idb-keyval is
 * the no-schema adapter.
 */
/**
 * What survives into the snapshot. The library default (`status === "success"`)
 * would drop a query the moment a poll fails — v5 flips status to `error`
 * while KEEPING data, so the live session would erase its own offline cache
 * exactly as the server dies. Last-known data is the asset: persist whatever
 * has data, whatever the error overlay says.
 */
export function shouldPersistQuery(query: { state: { data: unknown } }): boolean {
  return query.state.data !== undefined;
}

/** A restored infinite query must carry `{ pages, pageParams }`. */
function isInfiniteShaped(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && Array.isArray((data as { pages?: unknown }).pages)
  );
}

/**
 * Defense in depth behind the persister buster (see main.tsx). If a warm cache
 * holds a flat, non-infinite payload under an infinite query's key — a legacy
 * shape from before the query became infinite, or any drift a missed buster
 * bump let through — restoring it would crash react-query's `hasNextPage`
 * (`pages.length` on `undefined`) while the InfiniteQueryObserver mounts, i.e.
 * before app code or `getNextPageParam` ever run and before any error boundary
 * short of the whole route. Drop the stale entry so the query refetches
 * cleanly instead. Non-infinite queries pass through untouched.
 */
export function sanitizePersistedClient(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.filter((query) => {
    const root = Array.isArray(query.queryKey) ? query.queryKey[0] : undefined;
    if (typeof root === 'string' && INFINITE_QUERY_KEY_ROOTS.has(root)) {
      return query.state.data === undefined || isInfiniteShaped(query.state.data);
    }
    return true;
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}

export const persister = createAsyncStoragePersister({
  deserialize: (cached: string) => {
    // JSON.parse is `any`; the typed binding narrows without an assertion.
    const parsed: PersistedClient = JSON.parse(cached);
    return sanitizePersistedClient(parsed);
  },
  key: 'mimir-query-cache',
  storage: {
    getItem: async (key: string) => (await get<string>(key)) ?? null,
    removeItem: (key: string) => del(key),
    setItem: (key: string, value: string) => set(key, value),
  },
});
