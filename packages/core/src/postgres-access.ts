import { readInstallation } from './installation';
import {
  assertSandboxPostgresUrl,
  readSandboxAuthority,
  sandboxAuthorityFromEnvironment,
} from './sandbox-authority';

declare const MIMIR_HOST_AUTHORITY: boolean | undefined;

/** Enforce authority before a pg pool exists, including migrations and test workers. */
export function assertPostgresAccess(url: string): void {
  if (typeof MIMIR_HOST_AUTHORITY !== 'undefined' && MIMIR_HOST_AUTHORITY) {
    return;
  }
  const installation = readInstallation();
  if (installation?.mode === 'live') {
    return;
  }
  const authority =
    installation?.mode === 'sandbox'
      ? readSandboxAuthority(installation.sandboxAuthority)
      : sandboxAuthorityFromEnvironment();
  if (authority === undefined) {
    throw new Error(
      'Postgres requires a registered live installation or a launcher-owned sandbox. Use bun run sandbox create.',
    );
  }
  assertSandboxPostgresUrl(url, authority);
}
