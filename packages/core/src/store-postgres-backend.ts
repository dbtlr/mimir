import type { GlobalConfig } from './config';
import { configPath } from './config';
import { createSqlDoctorBackend } from './doctor/sql/backend';
import type { BuiltStore, StoreOverride } from './store-backend';
/**
 * The Postgres backend arm of the store composition root (ADR 0016, ADR 0030).
 * The one place outside `core/store-postgres` that opens
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
  postgresDialect,
  upgradeSchema,
} from './store-postgres/index';
import { OWNER_SCHEMA_REMEDY } from './store-sql/migrator';
import { createTokenStore } from './tokens';

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

/** Build the Postgres store for this process, upgrading for a designated store owner or
 * refusing a schema this caller does not read. */
export async function buildPostgresStore(
  config: GlobalConfig,
  options: Pick<StoreOverride, 'existing' | 'upgrade' | 'onMigration'> = {},
): Promise<BuiltStore> {
  const url = config.store.url;
  if (url === undefined) {
    throw postgresUrlMissing();
  }
  const handle = openPostgres(url);
  try {
    // An existing-only open never moves the schema, even when asked to upgrade.
    if (options.upgrade === true && options.existing !== true) {
      await upgradeSchema(handle.db, options.onMigration);
    }
    await assertSchemaCurrent(
      handle.db,
      options.existing === true ? OWNER_SCHEMA_REMEDY : undefined,
    );
  } catch (error) {
    // The gate refused: release the pool before the refusal propagates, or the
    // open connections keep the process alive past the error.
    await handle.close();
    throw error;
  }
  return {
    close: () => handle.close(),
    doctor: createSqlDoctorBackend(handle.db, postgresDialect),
    store: createPostgresStore(handle.db),
    tokens: createTokenStore({ db: handle.db, dialect: postgresDialect }),
  };
}
