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
import {
  createNornArtifactStore,
  createSqliteStore,
  readAllNodeDocs,
  withArtifactStore,
} from './core';
import type { Db, Store } from './core';
import { readVaultGraph } from './core/store-norn';
import type { VaultGraph } from './core/store-norn';
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
  /**
   * Release every backend resource: the source SQLite handle always, plus the
   * Norn subprocess when that artifact backend is active. Owns the db lifecycle
   * now that the raw handle no longer rides the Store (MMR-160) — callers close
   * the built store and nothing else.
   */
  close: () => Promise<void>;
  /**
   * Read every work-state document's raw markdown from the vault — the input for
   * `mimir doctor`'s body-section check (MMR-166). Present only on the Norn
   * backend (a vault diagnostic); `undefined` on SQLite signals doctor to no-op,
   * since typed rows carry no malformable body sections.
   */
  readNodeDocs?: (scope?: string) => Promise<{ stem: string; body: string }[]>;
  /**
   * Read the vault's raw, unresolved relational graph — the input for
   * `mimir doctor`'s referential checks (MMR-169 dangling refs, MMR-178 missing
   * project). Present only on the Norn backend; `undefined` on SQLite, where the
   * `parent_id`/`project_id` FKs preclude these failures.
   */
  readVaultGraph?: () => Promise<VaultGraph>;
  /**
   * Run norn's `vault.validate` and return its raw payload — the input for
   * `mimir doctor`'s frontmatter check (MMR-191), which surfaces documents whose
   * frontmatter fails to parse or has no `type` (invisible to every graph-based
   * check). Present only on the Norn backend; `undefined` on SQLite (typed rows
   * always have a valid type).
   */
  validate?: () => Promise<unknown>;
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
    return { close: () => db.destroy(), store: base };
  }
  const vault = resolveVault({
    configPath: readConfig().vault.path,
    envPath: process.env.MIMIR_VAULT,
  });
  await converge(vault.path, { allowCreate: vault.allowCreate, exec: bunExec });
  const client = new NornClient({ vaultPath: vault.path });
  return {
    close: async () => {
      await client.close();
      await db.destroy();
    },
    readNodeDocs: (scope) => readAllNodeDocs(client, scope),
    readVaultGraph: () => readVaultGraph(client),
    store: withArtifactStore(base, createNornArtifactStore(client)),
    validate: () => client.validate(),
  };
}
