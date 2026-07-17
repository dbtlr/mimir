/**
 * Composition root for the work-state store (ADR 0016). The Norn markdown vault
 * is the sole backend since MMR-234 — there is no backend selection. `buildStore`
 * resolves + converges the vault (creating it at a derived default path, adopting
 * an existing one, failing fast otherwise), attaches one persistent `norn mcp`
 * client for the process lifetime, and returns the store plus the vault
 * diagnostics `mimir doctor` reads. `close` shuts that client down; no other
 * resource is held (no db handle is opened, no db handle to close).
 */
import type { Store } from './core';
import { NornClient } from './core/store-norn/client';
import type { MigrationPlan } from './core/store-norn/plan';
import { createNornWriteStore } from './core/store-norn/writer';
import type { DoctorSnapshot } from './doctor/snapshot';
import { readDoctorSnapshot } from './doctor/snapshot';
import { bunExec } from './exec';
import { readConfig } from './service/config';
import { backfillVaultData } from './vault/backfill';
import { converge } from './vault/converge';
import { resolveVault } from './vault/resolve';

export type BuiltStore = {
  store: Store;
  /** Release every backend resource: the Norn subprocess. */
  close: () => Promise<void>;
  /** One whole-vault diagnostic enumeration shared by every doctor check. */
  readDoctorSnapshot: () => Promise<DoctorSnapshot>;
  /** CLI-only doctor repair mutation seam. */
  applyDoctorPlan: (plan: MigrationPlan, confirm: boolean) => Promise<unknown>;
  vaultRoot: string;
  /**
   * Read each path's exact on-disk text (frontmatter + body) — the location +
   * snippet enrichment source for the `/api/doctor` record-health facet (MMR-185).
   * Fetched by path so it resolves even for a document whose frontmatter won't
   * parse (invisible to the type-enumerated node read). norn 0.48 sources this
   * from `vault.get { format: "markdown" }` (the `.raw` facet was retired).
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
    applyDoctorPlan: (plan, confirm) => client.applyPlan(plan, confirm),
    close: () => client.close(),
    readDoctorSnapshot: () => readDoctorSnapshot(client),
    readRaw: (paths) => client.readRawDocuments(paths),
    store: createNornWriteStore(client, vault.path),
    vaultRoot: vault.path,
  };
}
