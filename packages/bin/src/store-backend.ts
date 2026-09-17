/**
 * Composition root for the work-state store (ADR 0016, ADR 0030). `[store]
 * backend` fences which backend this install runs on — `norn` (the markdown
 * vault, and the default) or `postgres`. The fence is per install, never per
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

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the Norn subprocess. */
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
 * The refusal for `[store] backend = "postgres"` before the Postgres backend
 * exists. A stable, exact message: an operator who set the fence early must be
 * told which release carries it, never handed a silent fallback to the vault.
 */
export const POSTGRES_BACKEND_UNAVAILABLE =
  '[store] backend = "postgres" is not available in this build: the Postgres store backend lands in MMR-379. Set backend = "norn" (the default) until then.';

/**
 * Build the store for this process. A converge failure (absent configured vault,
 * foreign directory) propagates so `serve` fails fast and a supervisor retries.
 * A `[store]` section that parsed to nothing usable is FATAL on the same terms:
 * the fence selects which store gets written, so a typo in a Postgres install
 * must never fall back to converging and writing a local markdown vault.
 */
export async function buildStore(
  opts: BuildStoreOptions = {},
  config: GlobalConfig = readRuntimeConfig(),
): Promise<BuiltStore> {
  if (config.store.problem !== undefined) {
    throw new Error(
      `[store] is unusable (${config.store.problem}) in ${configPath()} — set backend to one of: norn, postgres`,
    );
  }
  const backend = config.store.backend ?? DEFAULT_STORE_BACKEND;
  // `postgres` is a declared fence value with no backend behind it yet: refuse
  // by name rather than fall through to the vault (MMR-379 lands it).
  if (backend === 'postgres') {
    throw new Error(POSTGRES_BACKEND_UNAVAILABLE);
  }
  return await buildNornStore(config, opts);
}
