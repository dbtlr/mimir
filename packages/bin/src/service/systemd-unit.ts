/**
 * The systemd user serve unit (MMR-54), at parity with the launchd plist
 * (./plist): `<label>.service`, `Restart=always` (KeepAlive). `RestartSec`
 * matches launchd's ~10s throttle, so a squatter on the port is retried until it
 * leaves, and `StartLimitIntervalSec=0` means the manager never gives up.
 * `WantedBy=default.target` starts it with the user manager (RunAtLoad).
 *
 * Values are escaped for the unit-file grammar: specifiers (`%`) everywhere,
 * variables (`$`) in `ExecStart`, quotes and backslashes in quoted words. A line
 * break would end the directive and smuggle in another one, so it is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parsePort } from '@mimir/helpers';

import { IS_PRODUCTION, runtimePaths } from '../env';
import { SERVE_LOG_FILE } from './events';
import type { ServeUnitOptions } from './units';

/** A live unit lives in the user manager's search path; every other installation
 *  keeps its unit files in its own data directory, which `systemctl --user
 *  enable <path>` links into the manager. */
export function systemdUnitPathFor(fileName: string): string {
  return IS_PRODUCTION
    ? join(homedir(), '.config', 'systemd', 'user', fileName)
    : join(runtimePaths().data, 'systemd', fileName);
}

/** Read the MIMIR_PORT baked into a non-live installation's serve unit. */
export function readServeUnitPort(file: string): number | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const match = /^Environment="MIMIR_PORT=([^"]+)"$/m.exec(readFileSync(file, 'utf8'));
    return match?.[1] === undefined ? undefined : (parsePort(match[1]) ?? undefined);
  } catch {
    return undefined;
  }
}

function singleLine(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`unit file value contains a line break: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Escape specifiers; every unit-file value needs this. */
function specifiers(value: string): string {
  return singleLine(value).replace(/%/g, '%%');
}

/** A double-quoted word: backslashes and quotes escaped, specifiers doubled. */
function quoted(value: string): string {
  return `"${specifiers(value)
    .replace(/\\/g, String.raw`\\`)
    .replace(/"/g, String.raw`\"`)}"`;
}

/** An ExecStart argument: a quoted word with `$` variable expansion disabled. */
function execArg(value: string): string {
  return quoted(value).replace(/\$/g, () => '$$');
}

/** One `Environment=` line per defined key, in the given order. */
function environment(vars: Record<string, string | undefined>): string {
  return Object.entries(vars)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}\n`)
    .join('');
}

function logs(file: string): string {
  const target = specifiers(file);
  return `StandardOutput=append:${target}\nStandardError=append:${target}\n`;
}

export function serveUnitFor(label: string, binPath: string, opts: ServeUnitOptions): string {
  return `[Unit]
Description=Mimir server (${specifiers(label)})
StartLimitIntervalSec=0

[Service]
ExecStart=${execArg(binPath)} serve --no-hunt
Restart=always
RestartSec=10
${environment({
  MIMIR_PORT: opts.port === undefined ? undefined : String(opts.port),
})}${logs(SERVE_LOG_FILE)}
[Install]
WantedBy=default.target
`;
}
