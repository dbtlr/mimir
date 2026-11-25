import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { parse, stringify } from 'superjson';

import { BROWSE_CACHE_VERSION } from '../api/browse-queries';
import { NODE_CACHE_VERSION } from '../api/node-queries';
import { UNPERSISTED_QUERY_KEY_ROOTS } from '../api/queries';
import { SHELL_CACHE_VERSION } from '../api/shell-queries';
import { VIEW_CACHE_VERSION } from '../api/view-queries';

/**
 * Persisted-cache schema version. RULE: ANY change to the persisted shape of a
 * query (its queryKey shape, or its data shape — e.g. a plain query becoming an
 * infinite `{ pages, pageParams }` one, or a read changing its data type) MUST
 * change this. A stale-shape warm cache restored into the new code crashes the
 * route before app code runs; a new buster drops the old cache on restore.
 *
 * Each area's query module owns a version of its own, so a change bumps the
 * one beside the reads it reshapes and parallel work on different areas never
 * edits the same line. The `mimir-ui-v5` base changes only when the snapshot's
 * own encoding does (v5: superjson, so Engine `Date`s survive, MMR-537).
 */
export const PERSIST_BUSTER = [
  'mimir-ui-v5',
  `browse${String(BROWSE_CACHE_VERSION)}`,
  `node${String(NODE_CACHE_VERSION)}`,
  `shell${String(SHELL_CACHE_VERSION)}`,
  `view${String(VIEW_CACHE_VERSION)}`,
].join('.');

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
 * has data, whatever the error overlay says — except the passing questions
 * that are not board state ({@link UNPERSISTED_QUERY_KEY_ROOTS}).
 */
export function shouldPersistQuery(query: {
  queryKey: readonly unknown[];
  state: { data: unknown };
}): boolean {
  const root = query.queryKey[0];
  if (typeof root === 'string' && UNPERSISTED_QUERY_KEY_ROOTS.has(root)) {
    return false;
  }
  return query.state.data !== undefined;
}

/** A snapshot no restore accepts: its buster never matches, so the restore drops it. */
const STALE_SNAPSHOT: PersistedClient = {
  buster: '',
  clientState: { mutations: [], queries: [] },
  timestamp: 0,
};

const isPersistedClient = (value: unknown): value is PersistedClient =>
  typeof value === 'object' &&
  value !== null &&
  'buster' in value &&
  typeof value.buster === 'string' &&
  'clientState' in value &&
  typeof value.clientState === 'object' &&
  value.clientState !== null;

/**
 * The snapshot as stored. Engine reads answer `Date` instants, which plain
 * JSON would restore as strings, so the snapshot keeps superjson's type tags
 * (the codec the Engine's tRPC wire uses).
 */
export function serializeClient(client: PersistedClient): string {
  return stringify(client);
}

/**
 * The stored snapshot, back with its `Date`s. A snapshot this codec cannot read
 * (one written before it, or a corrupt one) reads as stale rather than failing
 * the restore.
 */
export function deserializeClient(cached: string): PersistedClient {
  let parsed: unknown;
  try {
    parsed = parse(cached);
  } catch {
    return STALE_SNAPSHOT;
  }
  return isPersistedClient(parsed) ? parsed : STALE_SNAPSHOT;
}

export const persister = createAsyncStoragePersister({
  deserialize: deserializeClient,
  key: 'mimir-query-cache',
  serialize: serializeClient,
  storage: {
    getItem: async (key: string) => (await get<string>(key)) ?? null,
    removeItem: (key: string) => del(key),
    setItem: (key: string, value: string) => set(key, value),
  },
});
