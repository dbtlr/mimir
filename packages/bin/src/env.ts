/** Runtime paths come from a verified installation, never a build profile. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePort } from '@mimir/helpers';

import { readInstallation } from './installation';
import { readSandboxAuthority, sandboxAuthorityFromEnvironment } from './sandbox-authority';

// Installer dispatch has no store access and must run before binding resolution.
const installing =
  process.argv[2] === 'installation-install' || process.argv[2] === 'installation-protocol';
const installation = installing ? undefined : readInstallation();
export const IS_PRODUCTION = installation?.mode === 'live';
export const PROD_PORT = 64647;
export const DEV_PORT = 64747;
export const DEFAULT_PORT = IS_PRODUCTION ? PROD_PORT : DEV_PORT;

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

export function defaultVaultPath(): string {
  return join(runtimePaths().data, 'vault');
}

/**
 * The `MIMIR_PORT` override for the port seam. Tolerant
 * like the config reader: an unset var yields `undefined` (use the next source),
 * a malformed one yields `null` so the caller can warn and fall through rather
 * than bind a bogus port.
 *
 * - unset → `undefined`
 * - a valid integer in 1–65535 → that number
 * - anything else → `null`
 */
export function envPort(raw = process.env.MIMIR_PORT): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parsePort(raw);
}
