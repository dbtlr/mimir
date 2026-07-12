/**
 * The launchd units (MMR-47, MMR-146). Two shapes share one escaper:
 *
 *   - **serve** — a KeepAlive daemon. ProgramArguments carry `serve --no-hunt`
 *     and NO port; the declared port lives in the global config, so retargeting
 *     never rewrites the plist. KeepAlive + the loud --no-hunt failure means
 *     launchd retries (~10s) while a squatter holds the port and self-heals.
 *   - **snapshot** — a StartInterval timer. It runs `vault snapshot` every
 *     interval and exits; a failure (missing volume, etc.) just re-fires next
 *     interval. No KeepAlive — a periodic command must not be kept alive.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SERVE_LOG_FILE, SNAPSHOT_LOG_FILE } from './events';

export const SERVE_LABEL = 'com.dbtlr.mimir.serve';
export const SNAPSHOT_LABEL = 'com.dbtlr.mimir.snapshot';

export function plistPathFor(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export type PlistOptions = {
  /**
   * `MIMIR_NORN` — the absolute path to the `norn` binary, resolved and existence-
   * checked at install time (mimir shells out to it, ADR 0018). Baked directly
   * rather than relying on `PATH`: launchd gives the daemon only a minimal default
   * `PATH` (no `$HOME/.cargo/bin`) and does no `~`/`$VAR` expansion, so a bare
   * `norn` is unresolvable.
   */
  nornPath?: string;
  /**
   * `MIMIR_VAULT` — the absolute vault directory, existence-checked at install
   * time. Baked so the daemon targets the vault via the highest-precedence source
   * (env over config) and cannot drift with a later config edit.
   */
  vaultPath?: string;
};

export type SnapshotPlistOptions = {
  /** launchd StartInterval — seconds between snapshot runs. */
  intervalSeconds: number;
  /** Baked in iff MIMIR_VAULT is set when `service install` runs (launchd does no shell expansion). */
  vaultPath?: string;
};

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

export function plistFor(binPath: string, opts: PlistOptions): string {
  const env = envDict({
    MIMIR_NORN: opts.nornPath,
    MIMIR_VAULT: opts.vaultPath,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVE_LABEL}</string>
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

export function plistForSnapshot(binPath: string, opts: SnapshotPlistOptions): string {
  const env = envDict({ MIMIR_VAULT: opts.vaultPath });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SNAPSHOT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binPath)}</string>
    <string>vault</string>
    <string>snapshot</string>
  </array>
  <key>StartInterval</key>
  <integer>${String(opts.intervalSeconds)}</integer>
  <key>StandardOutPath</key>
  <string>${SNAPSHOT_LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${SNAPSHOT_LOG_FILE}</string>${env}
</dict>
</plist>
`;
}
