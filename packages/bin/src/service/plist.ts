/**
 * The launchd unit (MMR-47). Deliberate shape: ProgramArguments carry
 * `serve --no-hunt` and NO port — the declared port lives in the global
 * config, so retargeting never rewrites the plist. KeepAlive + the loud
 * --no-hunt failure means launchd retries (~10s) while a squatter holds the
 * port and the daemon self-heals the moment it frees.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SERVE_LOG_FILE } from './events';

export const LABEL = 'com.dbtlr.mimir.serve';

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export interface PlistOptions {
  /** Baked in iff MIMIR_DB is set when `service install` runs. */
  dbPath?: string;
}

/** Escape XML special characters in element content (ampersand must go first).
 * launchctl rejects a malformed plist loudly at install time, but the error
 * doesn't point at the character — escaping here makes the root cause obvious. */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plistFor(binPath: string, opts: PlistOptions): string {
  const env =
    opts.dbPath === undefined
      ? ''
      : `
  <key>EnvironmentVariables</key>
  <dict>
    <key>MIMIR_DB</key>
    <string>${xmlEscape(opts.dbPath)}</string>
  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
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
  <string>${SERVE_LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${SERVE_LOG_FILE}</string>${env}
</dict>
</plist>
`;
}
