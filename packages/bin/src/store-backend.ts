/**
 * Composition root for the store backend (MMR-143/MMR-235, ADR 0016). A single
 * `[store] backend` selects the WHOLE work-state store: SQLite (default) or the
 * Norn markdown vault. The Norn branch returns the complete Norn store
 * (`createNornWriteStore` — nodes, artifacts, body sections, transitions), which
 * subsumes the transitional artifact-only wrap it replaced (MMR-143's Phase-2a
 * shim). Nodes are no longer pinned to SQLite; the flip is the config default.
 *
 * Precedence mirrors the other env seams: `MIMIR_STORE_BACKEND` env >
 * `[store] backend` in the global config > the built-in default (`sqlite`).
 *
 * When Norn is selected this converges the vault (creating it at a derived
 * default path, adopting an existing one, failing fast otherwise) and holds
 * one persistent `norn mcp` client for the process lifetime. `close` shuts that
 * client down; for the SQLite backend it is a no-op beyond the db handle.
 */
import { createSqliteStore, readAllNodeDocs, readSectionFailures } from './core';
import type { Db, Store } from './core';
import { readVaultGraph } from './core/store-norn';
import type { VaultGraph } from './core/store-norn';
import { bunExec } from './exec';
import { NornClient } from './norn/client';
import { pathAndRaw } from './norn/decode';
import { createNornWriteStore } from './norn/writer';
import { readConfig } from './service/config';
import { backfillVaultData } from './vault/backfill';
import { converge } from './vault/converge';
import { resolveVault } from './vault/resolve';

export type StoreBackend = 'sqlite' | 'norn';

/** The resolved store backend, env over config over default. `MIMIR_ARTIFACT_STORE`
 * is the pre-MMR-235 name, honored as a deprecated alias for one release. */
export function storeBackend(config = readConfig()): StoreBackend {
  const env = process.env.MIMIR_STORE_BACKEND ?? process.env.MIMIR_ARTIFACT_STORE;
  if (env === 'sqlite' || env === 'norn') {
    return env;
  }
  return config.store.backend ?? 'sqlite';
}

export type BuiltStore = {
  store: Store;
  /**
   * Release every backend resource: the source SQLite handle always, plus the
   * Norn subprocess when that backend is active. Owns the db lifecycle now that
   * the raw handle no longer rides the Store (MMR-160) — callers close the built
   * store and nothing else.
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
   * Read every work-state document whose `## History`/`## Annotations` heading
   * norn cannot resolve (ambiguous duplicate or missing) — the input for
   * `mimir doctor`'s section-resolution check (MMR-239), so the silent read-empty
   * degradation is diagnosable. Present only on the Norn backend; `undefined` on
   * SQLite (typed rows have no markdown body sections).
   */
  readSectionFailures?: (scope?: string) => Promise<{ stem: string; section: string }[]>;
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
  /**
   * Read each path's `.raw` disk text (frontmatter + body) — the location +
   * snippet enrichment source for the `/api/doctor` record-health facet (MMR-185).
   * Fetched by path so it resolves even for a document whose frontmatter won't
   * parse (invisible to the type-enumerated node read). Present only on the Norn
   * backend; `undefined` on SQLite (no vault documents to read).
   */
  readRaw?: (paths: string[]) => Promise<{ path: string; raw: string }[]>;
};

/**
 * Build the store for this process. For the Norn backend, resolve + converge the
 * vault and attach a persistent client; a converge failure (absent configured
 * vault, foreign directory) propagates so `serve` fails fast and a supervisor
 * retries.
 */
export async function buildStore(db: Db, backend = storeBackend()): Promise<BuiltStore> {
  if (backend === 'sqlite') {
    return { close: () => db.destroy(), store: createSqliteStore(db) };
  }
  const vault = resolveVault({
    configPath: readConfig().vault.path,
    envPath: process.env.MIMIR_VAULT,
  });
  await converge(vault.path, {
    allowCreate: vault.allowCreate,
    exec: bunExec,
    migrateData: backfillVaultData,
  });
  // `MIMIR_NORN` (baked into the serve launchd unit at install time) pins the
  // absolute norn binary — launchd's minimal PATH can't resolve a bare `norn`.
  const client = new NornClient({ command: process.env.MIMIR_NORN, vaultPath: vault.path });
  return {
    close: async () => {
      await client.close();
      await db.destroy();
    },
    readNodeDocs: (scope) => readAllNodeDocs(client, scope),
    readRaw: async (paths) => {
      if (paths.length === 0) {
        return [];
      }
      const records = await client.get(paths, '.raw');
      return records.flatMap((r) => {
        const pr = pathAndRaw(r);
        return pr === null ? [] : [pr];
      });
    },
    readSectionFailures: (scope) => readSectionFailures(client, scope),
    readVaultGraph: () => readVaultGraph(client),
    store: createNornWriteStore(client, vault.path),
    validate: () => client.validate(),
  };
}
