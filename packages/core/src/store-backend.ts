import type { GlobalConfig } from './config';
import { configPath, DEFAULT_STORE_BACKEND, hostOrigin, readRuntimeConfig } from './config';
import type { DoctorBackend } from './doctor/contract';
import { invariant } from './errors';
/**
 * Composition root for the work-state store (ADR 0030, ADR 0032). `[store]
 * backend` fences which backend this install runs on — `sqlite` (the local
 * tier, and the default) or `postgres` (the hosted tier). The fence is per install, never per
 * project: the working-set load is deliberately whole-store because dependency
 * edges cross project boundaries.
 *
 * This module is the fence and nothing else. It names no backend type: each arm
 * lives in its own module and returns a {@link BuiltStore} whose only doctor
 * surface is the backend's own facet (ADR 0030 Decision 6).
 */
import type { Store } from './store';
import { buildPostgresStore } from './store-postgres-backend';
import { buildSqliteStore } from './store-sqlite-backend';
import type { TokenStore } from './tokens';

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the database file or the pool. */
  close: () => Promise<void>;
  /** The backend's read-only doctor facet. */
  doctor: DoctorBackend;
  /** Host transport credentials, outside work state and board transfers. */
  tokens: TokenStore;
};

/**
 * Refuse a config that names a host, or a `[store]` section that parsed to
 * nothing usable. FATAL: the fence selects which store gets WRITTEN, so a typo
 * in a Postgres install must never fall back to creating and writing a local
 * store. The remedy names the key that actually went wrong — a bad URL is not
 * fixed by re-reading the list of backends.
 *
 * `file` names the config the section came from.
 */
export function assertUsableStoreConfig(config: GlobalConfig, file: string = configPath()): void {
  if (config.host !== undefined) {
    // Each store has one owner (ADR 0038): an install that names a host keeps no
    // local store, so a CLI that cannot reach the host opens none in its place.
    // A broken `[host]` refuses first, with its own fix.
    hostOrigin(config, file);
    throw invariant(
      `[host] is set in ${file}, and this mimir opens only a local store`,
      'use a mimir release with remote mode, or remove [host] to use a local store',
    );
  }
  const problem = config.store.problem;
  if (problem === undefined) {
    return;
  }
  throw invariant(`[store] is unusable (${problem}) in ${file}`, STORE_REMEDIES[problem]);
}

/** What fixes each unusable `[store]` — named per key, not one generic list. */
const STORE_REMEDIES: Record<NonNullable<GlobalConfig['store']['problem']>, string> = {
  'invalid-backend': 'set backend to sqlite, or remove [store] and pair with a host (`mimir pair`)',
  'invalid-url':
    'remove url: the CLI opens only a SQLite store, and a shared board runs on a host (`mimir pair`)',
  malformed: 'set backend to sqlite, or remove [store] and pair with a host (`mimir pair`)',
  'removed-backend':
    'the norn backend was removed (ADR 0032); export the vault with mimir v0.20 (`mimir store export <file>`), then remove the backend line and run `mimir store import <file> --apply`',
};

/** What a single run may override about the store it opens. */
export type StoreOverride = {
  /** Explicit SQLite location for a store owner, creating and migrating on open. */
  sqliteFile?: string;
  /** Designated store owners, such as the host, may upgrade a Postgres store before serving. */
  upgrade?: boolean;
  /**
   * Open the store as its owner left it: refuse a missing SQLite file or any
   * schema but this build's, and write nothing. It wins over `upgrade`. A
   * Postgres store is otherwise never moved without `upgrade`, so there it
   * only changes the remedy.
   */
  existing?: boolean;
  onMigration?: (name: string) => void;
};

/**
 * Build the store for this process. An open failure (a newer schema, an
 * unreadable or foreign database file, an unreachable server) propagates so the
 * caller fails fast. A config that names a host, or a `[store]` section that
 * parsed to nothing usable, is FATAL on the same terms — see
 * {@link assertUsableStoreConfig}.
 */
export async function buildStore(
  config: GlobalConfig = readRuntimeConfig(),
  override: StoreOverride = {},
): Promise<BuiltStore> {
  assertUsableStoreConfig(config);
  const backend = config.store.backend ?? DEFAULT_STORE_BACKEND;
  return backend === 'postgres'
    ? await buildPostgresStore(config, override)
    : await buildSqliteStore(override.sqliteFile, {
        existing: override.existing,
        onMigration: override.onMigration,
      });
}

/**
 * Build the store the CLI opens for itself: SQLite only. The host is the only
 * Mimir program that opens Postgres, so a CLI whose `[store]` names Postgres
 * (a `backend = "postgres"` or a `url`) refuses with the way to a host instead
 * of connecting. The host builds through {@link buildStore} with its own explicit
 * config and is unaffected.
 */
export async function buildLocalStore(
  config: GlobalConfig = readRuntimeConfig(),
  override: StoreOverride = {},
): Promise<BuiltStore> {
  assertUsableStoreConfig(config);
  if (config.store.backend === 'postgres' || config.store.url !== undefined) {
    throw invariant(
      `[store] names Postgres in ${configPath()}, and the CLI opens only a SQLite store`,
      'run the host against that database (docs/guides/host.md), remove [store], then pair the CLI with the host (`mimir pair <host-url>`); the host is the only program that opens Postgres. See docs/guides/move-to-a-host.md',
    );
  }
  return await buildSqliteStore(override.sqliteFile, {
    existing: override.existing,
    onMigration: override.onMigration,
  });
}
