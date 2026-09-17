/**
 * The Postgres backend arm of the store composition root (ADR 0016, ADR 0030).
 * The one place outside `core/store-postgres` and `doctor/postgres` that opens
 * a connection: it reads `[store] url`, opens the pool, passes the schema gate,
 * and pairs the write store with the backend's own doctor facet. `close`
 * releases the pool.
 *
 * The gate runs HERE, once per process, rather than inside the store: "which
 * schema is this?" is a question about the connection, not about each read, and
 * a store that re-asked it per call would pay for it on every query. A store
 * this function returns has already answered it.
 */
import {
  assertSchemaCurrent,
  createPostgresStore,
  openPostgres,
} from './core/store-postgres/index';
import { createPostgresDoctorBackend } from './doctor/postgres/backend';
import type { GlobalConfig } from './service/config';
import { configPath } from './service/config';
import type { BuildStoreOptions, BuiltStore } from './store-backend';

/**
 * The refusal for a Postgres install with no connection URL. It names the key,
 * the file it belongs in, and the guide, because the operator who sees it has
 * set exactly one of the two keys the backend needs. Shared with `store
 * upgrade`, which needs the same URL and must refuse in the same words.
 */
export function postgresUrlMissing(): Error {
  return new Error(
    `[store] backend = "postgres" needs [store] url in ${configPath()} — the Postgres connection URL. See docs/guides/postgres-store.md`,
  );
}

/**
 * Build the Postgres store for this process. `opts` carries the doctor repair
 * capability the Norn arm wires; this backend has no repair pass to wire (every
 * state its doctor reports is unreachable through the binary and points at a
 * hand edit), so the option is deliberately unused here.
 */
export async function buildPostgresStore(
  config: GlobalConfig,
  _opts: BuildStoreOptions,
): Promise<BuiltStore> {
  const url = config.store.url;
  if (url === undefined) {
    throw postgresUrlMissing();
  }
  const handle = openPostgres(url);
  try {
    await assertSchemaCurrent(handle.db);
  } catch (error) {
    // The gate refused: release the pool before the refusal propagates, or the
    // open connections keep the process alive past the error.
    await handle.close();
    throw error;
  }
  return {
    close: () => handle.close(),
    doctor: createPostgresDoctorBackend(handle.db),
    store: createPostgresStore(handle.db),
  };
}
