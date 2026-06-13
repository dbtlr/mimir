/**
 * The global config (MMR-47) — the stable, declared source for daemon
 * settings, `[serve] port` first. The plist never carries a port: the daemon
 * reads this file at startup, so retargeting is edit-config + restart.
 * Serve's port precedence: --port flag > config > built-in default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServeConfig {
  port?: number;
}

/** `$XDG_CONFIG_HOME/mimir/config.toml`, defaulting to `~/.config`. */
export function configPath(xdgConfigHome = process.env.XDG_CONFIG_HOME): string {
  const base = xdgConfigHome ?? join(homedir(), ".config");
  return join(base, "mimir", "config.toml");
}

/**
 * Read the `[serve]` section. Tolerant by design: a missing, malformed, or
 * wrong-typed file reads as empty so interactive `serve` still starts on the
 * default — the loud-failure posture belongs to the port bind, not the parse.
 */
export function readServeConfig(file = configPath()): ServeConfig {
  if (!existsSync(file)) return {};
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as {
      serve?: { port?: unknown };
    };
    const port = parsed.serve?.port;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { port };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write the serve port (the `service install --port` discovery path). The
 * config owns exactly one key today, so a whole-file write is honest; this
 * writer learns to merge when a second key arrives.
 */
export function writeServePort(file: string, port: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `[serve]\nport = ${String(port)}\n`);
}
