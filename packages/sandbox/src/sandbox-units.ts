/**
 * Supervisor teardown for a sandbox installation (MMR-54). Any registered
 * sandbox may install real launchd or systemd units under its own
 * sandbox-scoped names, so every sandbox cleanup path unloads them before its
 * directory, and with it the unit's executable, disappears.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { unitLabels } from '../../bin/src/service/units';
import { attempt } from './process';

/** Unload a sandbox's units: through its own binary first, then a direct backstop
 *  for a half-installed unit. Every call addresses only sandbox-scoped names. */
export async function removeSandboxUnits(id: string, root: string): Promise<void> {
  const binary = join(root, 'bin', 'mimir');
  if (existsSync(binary)) {
    await attempt([binary, 'service', 'uninstall', 'all'], root);
  }
  for (const label of Object.values(unitLabels({ id, kind: 'sandbox' }))) {
    if (process.platform === 'darwin') {
      await attempt(
        ['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? 501)}/${label}`],
        root,
      );
    } else if (process.platform === 'linux') {
      // Stop before disable: `disable --now` refuses a unit whose file is gone
      // without stopping it, and Restart=always would keep it running.
      for (const unit of [`${label}.service`, `${label}.timer`]) {
        await attempt(['systemctl', '--user', 'stop', unit], root);
        await attempt(['systemctl', '--user', 'disable', unit], root);
      }
    }
  }
}
