/**
 * The serve unit's baked environment, resolved and validated at `service install`
 * time. On the Norn backend this is a preflight guard, not just a value: the
 * daemon shells out to the `norn` binary (ADR 0018) and reads the vault, and
 * launchd hands it only a minimal `PATH` with no `~`/`$VAR` expansion. So a norn
 * that is not on PATH would install a unit that boots green and then fails every
 * request. Fail the install loudly instead — and bake the **absolute** norn path
 * (`MIMIR_NORN`) directly, so the daemon is hermetic and cannot drift with a
 * later config edit.
 *
 * The vault is baked only when it is an *explicit* path (env or config): that
 * path must already exist (a missing explicit path is the late-mount hazard
 * `resolveVault` forbids), and baking `MIMIR_VAULT` pins it. The **auto-creatable
 * default** (`allowCreate`) is deliberately NOT baked: baking it as an env path
 * would flip `resolveVault`'s `allowCreate` off at the daemon and disable the
 * boot-time `converge` that materializes a fresh default vault — so a first-boot
 * install would strand itself. Left unbaked, the daemon re-derives the identical
 * default and creates it.
 *
 * On SQLite there is no norn/vault dependency, so this only carries `MIMIR_DB`
 * (the pre-existing behavior).
 */
import { existsSync } from 'node:fs';

import { notFound } from '../core';
import type { StoreBackend } from '../store-backend';
import type { ResolvedVault } from '../vault/resolve';
import type { PlistOptions } from './plist';

export type ServeInstallInputs = {
  /** The resolved store backend at install time. */
  backend: StoreBackend;
  /** `process.env.MIMIR_DB` — baked on the SQLite backend, as before. */
  dbPath?: string;
  /** The absolute `norn` binary path (`Bun.which('norn')`), or undefined if unresolved. */
  nornPath?: string;
  /** The resolved vault (env over config over default), carrying `allowCreate`. */
  vault?: ResolvedVault;
};

export function serveInstallEnv(inputs: ServeInstallInputs): PlistOptions {
  if (inputs.backend === 'sqlite') {
    return { dbPath: inputs.dbPath };
  }
  if (inputs.nornPath === undefined) {
    throw notFound(
      'service install: the Norn backend requires the `norn` binary, but it is not on PATH.',
      'install norn (or add it to PATH), then re-run `mimir service install`',
    );
  }
  const vault = inputs.vault;
  // The auto-creatable default is left for the daemon's boot-time converge —
  // don't require it to exist and don't bake it (baking would disable that).
  if (vault === undefined || vault.allowCreate) {
    return { nornPath: inputs.nornPath };
  }
  if (!existsSync(vault.path)) {
    throw notFound(
      `service install: the configured vault does not exist: ${vault.path}`,
      'run `mimir migrate nodes` (or fix [vault] path), then re-run `mimir service install`',
    );
  }
  return { nornPath: inputs.nornPath, vaultPath: vault.path };
}
