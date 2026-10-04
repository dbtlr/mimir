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
import { existsSync } from 'node:fs';

import type { Store } from './core';
import { invariant } from './core/errors';
import type { DoctorBackend } from './doctor/contract';
import type { GlobalConfig, StoreBackend } from './service/config';
import { configPath, DEFAULT_STORE_BACKEND, readRuntimeConfig } from './service/config';
import { buildPostgresStore } from './store-postgres-backend';
import { buildSqliteStore } from './store-sqlite-backend';

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the database file or the pool. */
  close: () => Promise<void>;
  /** The backend's read-only doctor facet. */
  doctor: DoctorBackend;
};

/**
 * Refuse a `[store]` section that parsed to nothing usable. FATAL: the fence
 * selects which store gets WRITTEN, so a typo in a Postgres install must never
 * fall back to creating and writing a local store. The remedy names the key that actually went wrong —
 * a bad URL is not fixed by re-reading the list of backends.
 *
 * Shared with `store upgrade` and `setup`, which read the same section for the
 * same fence; `file` names the config the section came from.
 */
export function assertUsableStoreConfig(config: GlobalConfig, file: string = configPath()): void {
  const problem = config.store.problem;
  if (problem === undefined) {
    return;
  }
  throw invariant(`[store] is unusable (${problem}) in ${file}`, STORE_REMEDIES[problem]);
}

/** What fixes each unusable `[store]` — named per key, not one generic list. */
const STORE_REMEDIES: Record<NonNullable<GlobalConfig['store']['problem']>, string> = {
  'invalid-backend': 'set backend to one of: sqlite, postgres',
  'invalid-url': 'set url to a Postgres connection URL (a non-empty string)',
  malformed: 'set backend to one of: sqlite, postgres',
  'removed-backend':
    'the norn backend was removed (ADR 0032); export the vault with mimir v0.20 (`mimir store export <file>`), then remove the backend line and run `mimir store import <file> --apply`',
};

/** What a single run may override about the store it opens. */
export type StoreOverride = {
  /** A SQLite file to open instead of the installation's own (`serve --store`).
   * It must already exist: opening a typo would create and serve an empty store. */
  file?: string;
};

/**
 * Build the store for this process. An open failure (a newer schema, an
 * unreadable or foreign database file, an unreachable server) propagates so `serve` fails fast and a supervisor retries.
 * A `[store]` section that parsed to nothing usable is FATAL on the same terms
 * — see {@link assertUsableStoreConfig}.
 */
export async function buildStore(
  config: GlobalConfig = readRuntimeConfig(),
  override: StoreOverride = {},
): Promise<BuiltStore> {
  assertUsableStoreConfig(config);
  const backend = config.store.backend ?? DEFAULT_STORE_BACKEND;
  if (override.file !== undefined) {
    return await buildNamedSqliteStore(backend, override.file);
  }
  return backend === 'postgres' ? await buildPostgresStore(config) : await buildSqliteStore();
}

/** Open the SQLite file a run named, refusing what would serve the wrong store. */
async function buildNamedSqliteStore(backend: StoreBackend, file: string): Promise<BuiltStore> {
  if (backend !== 'sqlite') {
    throw invariant(
      `--store names a SQLite file, but this install runs the ${backend} backend`,
      'drop --store, or run it from a SQLite install or a source checkout',
    );
  }
  if (!existsSync(file)) {
    throw invariant(`no store file at ${file}`, 'name an existing SQLite store file');
  }
  return await buildSqliteStore(file);
}
