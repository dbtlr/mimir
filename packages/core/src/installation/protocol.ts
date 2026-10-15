import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const INSTALLATION_PROTOCOL_RESPONSE = '{"installationProtocol":1}';

/** Old candidates run only with empty configuration during compatibility checks. */
export function requireInstallationProtocol(candidate: string): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-install-preflight-')));
  try {
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    for (const path of [config, data, cache]) {
      mkdirSync(path);
    }
    const result = spawnSync(resolve(candidate), ['installation-protocol'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        HOME: root,
        NO_COLOR: '1',
        PATH: '/usr/bin:/bin',
        TMPDIR: root,
        XDG_CACHE_HOME: cache,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
      },
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      result.stdout.trim() !== INSTALLATION_PROTOCOL_RESPONSE
    ) {
      throw new Error(
        'Candidate does not support installation protocol version 1. Build a compatible Mimir binary before installation.',
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
