import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { del, get, set } from 'idb-keyval';

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

export const persister = createAsyncStoragePersister({
  key: 'mimir-query-cache',
  storage: {
    getItem: async (key: string) => (await get<string>(key)) ?? null,
    removeItem: (key: string) => del(key),
    setItem: (key: string, value: string) => set(key, value),
  },
});
