/**
 * The Norn backend arm of the store composition root (ADR 0016, ADR 0030). The
 * one place outside `core/store-norn` and `doctor/norn` that names a Norn
 * client: it resolves + converges the markdown vault (creating it at a derived
 * default path, adopting an existing one, failing fast otherwise), attaches one
 * persistent `norn mcp` client for the process lifetime, and pairs the write
 * store with the backend's own doctor facet. `close` shuts that client down; no
 * other resource is held (no db handle is opened, no db handle to close).
 */
import { NornClient } from './core/store-norn/client';
import { createNornWriteStore } from './core/store-norn/writer';
import { createNornDoctorBackend, nornDoctorDeps } from './doctor/norn/backend';
import { bunExec } from './exec';
import type { GlobalConfig } from './service/config';
import type { BuildStoreOptions, BuiltStore } from './store-backend';
import { backfillVaultData } from './vault/backfill';
import { converge } from './vault/converge';
import { resolveVault } from './vault/resolve';

export async function buildNornStore(
  config: GlobalConfig,
  opts: BuildStoreOptions,
): Promise<BuiltStore> {
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
    doctor: createNornDoctorBackend(
      nornDoctorDeps(client, vault.path, { repair: opts.repair === true }),
    ),
    store: createNornWriteStore(client, vault.path),
  };
}
