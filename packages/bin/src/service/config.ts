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
  /** Set when a config file exists but contributed nothing — callers may warn. */
  problem?: "malformed" | "invalid-port";
}

/** `$XDG_CONFIG_HOME/mimir/config.toml`, defaulting to `~/.config`. */
export function configPath(xdgConfigHome = process.env.XDG_CONFIG_HOME): string {
  const base = xdgConfigHome ?? join(homedir(), ".config");
  return join(base, "mimir", "config.toml");
}

/**
 * Read the `[serve]` section. Tolerant by design: a missing, malformed, or
 * wrong-typed file never throws — the loud-failure posture belongs to the port
 * bind, not the parse. When a file is present but contributed nothing, `problem`
 * is set so the serve startup path can warn that the config was ignored.
 *
 * - Missing file → `{}`
 * - Parse/read throws → `{ problem: "malformed" }`
 * - `serve.port` present but not a valid integer in 1–65535 → `{ problem: "invalid-port" }`
 * - `serve.port` absent → `{}` (not a problem; the default will be used)
 * - Valid port → `{ port }`
 */
export function readServeConfig(file = configPath()): ServeConfig {
  if (!existsSync(file)) return {};
  let parsed: { serve?: { port?: unknown } };
  try {
    parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as {
      serve?: { port?: unknown };
    };
  } catch {
    return { problem: "malformed" };
  }
  const port = parsed.serve?.port;
  // No port key at all — not a problem, caller uses the default.
  if (port === undefined) return {};
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) {
    return { port };
  }
  return { problem: "invalid-port" };
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
