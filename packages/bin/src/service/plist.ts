/**
 * The launchd serve unit (MMR-47): a KeepAlive daemon whose ProgramArguments
 * carry `serve --no-hunt`. Live installations resolve the port from their bound
 * configuration. KeepAlive + the loud --no-hunt failure means launchd retries
 * (~10s) while a squatter holds the port and self-heals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parsePort } from '@mimir/helpers';

import { IS_PRODUCTION, runtimePaths } from '../env';
import { SERVE_LOG_FILE } from './events';
import type { ServeUnitOptions } from './units';

/** A live unit lives in `~/Library/LaunchAgents` so launchd loads it at login;
 *  every other installation keeps its plist in its own data directory
 *  (`launchctl bootstrap` takes any path). */
export function plistPathFor(label: string): string {
  return IS_PRODUCTION
    ? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    : join(runtimePaths().data, 'LaunchAgents', `${label}.plist`);
}

/** Read the dev-only MIMIR_PORT baked into an owned serve plist. */
export function readServePlistPort(file: string): number | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const xml = readFileSync(file, 'utf8');
    const match = /<key>MIMIR_PORT<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1] === undefined ? undefined : (parsePort(match[1]) ?? undefined);
  } catch {
    return undefined;
  }
}

/** Escape XML special characters in element content (ampersand must go first).
 * launchctl rejects a malformed plist loudly at install time, but the error
 * doesn't point at the character — escaping here makes the root cause obvious. */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An `EnvironmentVariables` dict of every defined key, in the given order, or
 * '' when none are set. */
function envDict(vars: Record<string, string | undefined>): string {
  const entries = Object.entries(vars).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) {
    return '';
  }
  const body = entries
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `
  <key>EnvironmentVariables</key>
  <dict>
${body}
  </dict>`;
}

export function plistFor(label: string, binPath: string, opts: ServeUnitOptions): string {
  const env = envDict({
    MIMIR_PORT: opts.port === undefined ? undefined : String(opts.port),
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binPath)}</string>
    <string>serve</string>
    <string>--no-hunt</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(SERVE_LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(SERVE_LOG_FILE)}</string>${env}
</dict>
</plist>
`;
}
