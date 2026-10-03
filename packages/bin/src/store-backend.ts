/**
 * Composition root for the work-state store (ADR 0030, ADR 0032). `[store]
 * backend` fences which backend this install runs on — `sqlite` (the local
 * tier, and the default), `postgres` (the hosted tier), or `norn` (the
 * markdown vault, until its removal). The fence is per install, never per
 * project: the working-set load is deliberately whole-store because dependency
 * edges cross project boundaries.
 *
 * This module is the fence and nothing else. It names no backend type: each arm
 * lives in its own module and returns a {@link BuiltStore} whose only doctor
 * surface is the backend's own facet (ADR 0030 Decision 6).
 */
import type { Store } from './core';
import type { DoctorBackend } from './doctor/contract';
import type { GlobalConfig } from './service/config';
import { configPath, DEFAULT_STORE_BACKEND, readRuntimeConfig } from './service/config';
import { buildNornStore } from './store-norn-backend';
import { buildPostgresStore } from './store-postgres-backend';
import { buildSqliteStore } from './store-sqlite-backend';

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the database, the pool, or the Norn subprocess. */
  close: () => Promise<void>;
  /**
   * The backend's doctor facet. `repair` is present only where the caller asked
   * for a mutating wiring — see {@link buildStore}'s `repair` option.
   */
  doctor: DoctorBackend;
};

/** Options for the one capability the composition root decides per transport. */
export type BuildStoreOptions = {
  /**
   * Wire the doctor repair capability. The CLI passes `true`; the read-only
   * transports (`serve`, `mcp`) leave it off, so the backend they hold cannot
   * mutate the store through doctor at all.
   */
  repair?: boolean;
};

/**
 * Refuse a `[store]` section that parsed to nothing usable. FATAL on the same
 * terms as a failed converge: the fence selects which store gets WRITTEN, so a
 * typo in a Postgres install must never fall back to converging and writing a
 * local store. The remedy names the key that actually went wrong —
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
  const remedy =
    problem === 'invalid-url'
      ? 'set url to a Postgres connection URL (a non-empty string)'
      : 'set backend to one of: sqlite, postgres, norn';
  throw new Error(`[store] is unusable (${problem}) in ${file} — ${remedy}`);
}

/**
 * Build the store for this process. An open failure (a newer schema, an
 * unreadable database file) or a Norn converge failure (absent configured vault,
 * foreign directory) propagates so `serve` fails fast and a supervisor retries.
 * A `[store]` section that parsed to nothing usable is FATAL on the same terms
 * — see {@link assertUsableStoreConfig}.
 */
export async function buildStore(
  opts: BuildStoreOptions = {},
  config: GlobalConfig = readRuntimeConfig(),
): Promise<BuiltStore> {
  assertUsableStoreConfig(config);
  const backend = config.store.backend ?? DEFAULT_STORE_BACKEND;
  if (backend === 'sqlite') {
    return await buildSqliteStore(opts);
  }
  if (backend === 'postgres') {
    return await buildPostgresStore(config, opts);
  }
  return await buildNornStore(config, opts);
}
