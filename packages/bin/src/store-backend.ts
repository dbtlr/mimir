/**
 * Composition root for the work-state store (ADR 0016). The Norn markdown vault
 * is the sole backend since MMR-234 — there is no backend selection. `buildStore`
 * resolves + converges the vault (creating it at a derived default path, adopting
 * an existing one, failing fast otherwise), attaches one persistent `norn mcp`
 * client for the process lifetime, and returns the store plus the vault
 * diagnostics `mimir doctor` reads. `close` shuts that client down; no other
 * resource is held (no db handle is opened, no db handle to close).
 */
import { readAllNodeDocs, readSectionFailures } from './core';
import type { Store } from './core';
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

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the Norn subprocess. */
  close: () => Promise<void>;
  /**
   * Read every work-state document's raw markdown from the vault — the input for
   * `mimir doctor`'s body-section check (MMR-166).
   */
  readNodeDocs: (scope?: string) => Promise<{ stem: string; body: string }[]>;
  /**
   * Read every work-state document whose `## History`/`## Annotations` heading
   * norn cannot resolve (ambiguous duplicate or missing) — the input for
   * `mimir doctor`'s section-resolution check (MMR-239).
   */
  readSectionFailures: (scope?: string) => Promise<{ stem: string; section: string }[]>;
  /**
   * Read the vault's raw, unresolved relational graph — the input for
   * `mimir doctor`'s referential checks (MMR-169 dangling refs, MMR-178 missing
   * project).
   */
  readVaultGraph: () => Promise<VaultGraph>;
  /**
   * Run norn's `vault.validate` and return its raw payload — the input for
   * `mimir doctor`'s frontmatter check (MMR-191).
   */
  validate: () => Promise<unknown>;
  /**
   * Read each path's `.raw` disk text (frontmatter + body) — the location +
   * snippet enrichment source for the `/api/doctor` record-health facet (MMR-185).
   * Fetched by path so it resolves even for a document whose frontmatter won't
   * parse (invisible to the type-enumerated node read).
   */
  readRaw: (paths: string[]) => Promise<{ path: string; raw: string }[]>;
};

/**
 * Build the store for this process: resolve + converge the vault and attach a
 * persistent client. A converge failure (absent configured vault, foreign
 * directory) propagates so `serve` fails fast and a supervisor retries.
 */
export async function buildStore(): Promise<BuiltStore> {
  const config = readConfig();
  if (config.store.backend !== undefined) {
    // Friendly retirement of the MMR-232 fence: an old `[store] backend` key is
    // ignored (not an error) so an existing config keeps working — one note, then
    // the Norn vault regardless.
    console.error(
      '⚠ config: [store] backend is ignored — the Norn vault is the only backend (MMR-234); remove the key to silence this',
    );
  }
  const vault = resolveVault({
    configPath: config.vault.path,
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
    close: () => client.close(),
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
