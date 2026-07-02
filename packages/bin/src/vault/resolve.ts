/**
 * Vault path resolution (MMR-142): `MIMIR_VAULT` env > `[vault] path` in the
 * global config > the build-profile default — mirroring the `MIMIR_DB`
 * precedence exactly. `.mimir.toml` never names a vault (ADR 0011: the repo
 * binding carries repo facts; which store is an environment fact).
 *
 * `allowCreate` encodes the mount-safety rule: only the *derived default*
 * path may be auto-created at runtime. An explicitly configured path (env or
 * config) that is absent is an error at the call site — on a late-mounted
 * volume, silently scaffolding a fresh vault at the unmounted path is
 * exactly the failure this forbids. Creation at a custom path is the
 * interactive setup flow's job.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultVaultPath } from '../env';

export type VaultSource = 'env' | 'config' | 'default';

export type ResolvedVault = {
  path: string;
  source: VaultSource;
  /** True only for the derived default — the one path converge may create at runtime. */
  allowCreate: boolean;
};

/**
 * Expand `~` / a leading `~/` against the home directory — a hand-edited
 * config courtesy, and a real case under launchd, whose EnvironmentVariables
 * perform no shell expansion. (`~user` is not supported and passes through.)
 */
function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function resolveVault(sources: {
  envPath?: string | undefined;
  configPath?: string | undefined;
}): ResolvedVault {
  if (sources.envPath !== undefined && sources.envPath !== '') {
    return { allowCreate: false, path: expandTilde(sources.envPath), source: 'env' };
  }
  if (sources.configPath !== undefined && sources.configPath !== '') {
    return { allowCreate: false, path: expandTilde(sources.configPath), source: 'config' };
  }
  return { allowCreate: true, path: defaultVaultPath(), source: 'default' };
}
