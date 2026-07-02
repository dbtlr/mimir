/**
 * Composition root for the store backend (MMR-143, ADR 0016 Phase 2a). The
 * node/project/verb store is always SQLite; the **artifact slice** is selected
 * by the backend flag: SQLite (default) or the Norn vault.
 *
 * Precedence mirrors the other env seams: `MIMIR_ARTIFACT_STORE` env >
 * `[store] artifacts` in the global config > the built-in default (`sqlite`).
 *
 * When Norn is selected this converges the vault (creating it at a derived
 * default path, adopting an existing one, failing fast otherwise) and holds
 * one persistent `norn mcp` client for the process lifetime. `closeStore`
 * shuts that client down; for the SQLite backend it is a no-op.
 */
import { createNornArtifactStore, createSqliteStore, withArtifactStore } from './core';
import type { Db, Store } from './core';
import { bunExec } from './exec';
import { NornClient } from './norn/client';
import { readConfig } from './service/config';
import { converge } from './vault/converge';
import { resolveVault } from './vault/resolve';

export type ArtifactBackend = 'sqlite' | 'norn';

/** The resolved artifact backend, env over config over default. */
export function artifactBackend(config = readConfig()): ArtifactBackend {
  const env = process.env.MIMIR_ARTIFACT_STORE;
  if (env === 'sqlite' || env === 'norn') {
    return env;
  }
  return config.store.artifacts ?? 'sqlite';
}

export type BuiltStore = {
  store: Store;
  /** Release backend resources (the Norn subprocess); a no-op for SQLite. */
  close: () => Promise<void>;
};

/**
 * Build the store for this process. For the Norn artifact backend, resolve +
 * converge the vault and attach a persistent client; a converge failure
 * (absent configured vault, foreign directory) propagates so `serve` fails
 * fast and a supervisor retries.
 */
export async function buildStore(db: Db, backend = artifactBackend()): Promise<BuiltStore> {
  const base = createSqliteStore(db);
  if (backend === 'sqlite') {
    return { close: () => Promise.resolve(), store: base };
  }
  const vault = resolveVault({
    configPath: readConfig().vault.path,
    envPath: process.env.MIMIR_VAULT,
  });
  await converge(vault.path, { allowCreate: vault.allowCreate, exec: bunExec });
  const client = new NornClient({ vaultPath: vault.path });
  return {
    close: () => client.close(),
    store: withArtifactStore(base, createNornArtifactStore(client)),
  };
}
