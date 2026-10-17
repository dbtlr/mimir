/** Runtime paths come from a verified installation, never a build profile. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readInstallation } from './installation';
import { readSandboxAuthority, sandboxAuthorityFromEnvironment } from './sandbox-authority';
import { SQLITE_FILE } from './store-sqlite/client';

// Installer dispatch has no store access and must run before binding resolution.
const installing =
  process.argv[2] === 'installation-install' || process.argv[2] === 'installation-protocol';
const installation = installing ? undefined : readInstallation();
export const IS_PRODUCTION = installation?.mode === 'live';

export function runtimePaths(): { config: string; data: string; cache: string } {
  if (installation?.mode === 'live') {
    return installation.paths;
  }
  if (!installing) {
    const authority =
      installation?.mode === 'sandbox'
        ? readSandboxAuthority(installation.sandboxAuthority)
        : sandboxAuthorityFromEnvironment();
    if (authority !== undefined) {
      if (
        installation?.mode === 'sandbox' &&
        (['config', 'data', 'cache'] as const).some(
          (key) => authority.paths[key] !== installation.paths[key],
        )
      ) {
        throw new Error('Sandbox installation paths do not match its authority.');
      }
      return authority.paths;
    }
  }
  const root = import.meta.url.startsWith('file:///$bunfs/')
    ? join(dirname(process.execPath), '.dev')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.dev');
  return { cache: join(root, 'cache', 'mimir'), config: join(root, 'config', 'mimir'), data: root };
}

/** The local SQLite store's database file (ADR 0032): one per installation. */
export function sqliteStorePath(): string {
  return join(runtimePaths().data, SQLITE_FILE);
}
