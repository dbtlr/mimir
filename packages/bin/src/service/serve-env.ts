/**
 * The serve unit's baked environment, resolved and validated at `service install`
 * time. On the Norn backend this is a preflight guard, not just a value: the
 * daemon shells out to the `norn` binary (ADR 0018) and reads the vault, and
 * launchd hands it only a minimal `PATH` with no `~`/`$VAR` expansion. So a norn
 * that is not on PATH, or a vault directory that does not exist, would install a
 * unit that boots green and then fails every request. Fail the install loudly
 * instead — and bake both **absolute** paths directly (`MIMIR_NORN` / `MIMIR_VAULT`),
 * so the daemon is hermetic and cannot drift with a later config edit.
 *
 * On SQLite there is no norn/vault dependency, so this only carries `MIMIR_DB`
 * (the pre-existing behavior).
 */
import { existsSync } from 'node:fs';

import { notFound } from '../core';
import type { StoreBackend } from '../store-backend';
import type { PlistOptions } from './plist';

export type ServeInstallInputs = {
  /** The resolved store backend at install time. */
  backend: StoreBackend;
  /** `process.env.MIMIR_DB` — baked on the SQLite backend, as before. */
  dbPath?: string;
  /** The absolute `norn` binary path (`Bun.which('norn')`), or undefined if unresolved. */
  nornPath?: string;
  /** The resolved absolute vault directory (env over config over default). */
  vault: string;
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
  if (!existsSync(inputs.vault)) {
    throw notFound(
      `service install: the configured vault does not exist: ${inputs.vault}`,
      'run `mimir migrate nodes` (or set [vault] path), then re-run `mimir service install`',
    );
  }
  return { nornPath: inputs.nornPath, vaultPath: inputs.vault };
}
