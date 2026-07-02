/**
 * The global config (MMR-47) — the stable, declared source for daemon
 * settings, `[serve] port` first. The plist never carries a port: the daemon
 * reads this file at startup, so retargeting is edit-config + restart.
 * Serve's port precedence: --port flag > config > built-in default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ServeConfig = {
  port?: number;
  /** Set when a config file exists but contributed nothing — callers may warn. */
  problem?: 'malformed' | 'invalid-port';
};

/** `$XDG_CONFIG_HOME/mimir/config.toml`, defaulting to `~/.config`. */
export function configPath(xdgConfigHome = process.env.XDG_CONFIG_HOME): string {
  const base = xdgConfigHome ?? join(homedir(), '.config');
  return join(base, 'mimir', 'config.toml');
}

export type VaultConfig = {
  path?: string;
  /** Set when a config file exists but contributed nothing — callers may warn. */
  problem?: 'malformed' | 'invalid-path';
};

export type StoreConfig = {
  /** Which backend serves artifacts — SQLite (default) or the Norn vault (MMR-143). */
  artifacts?: 'sqlite' | 'norn';
  problem?: 'malformed' | 'invalid-artifacts';
};

export type GlobalConfig = { serve: ServeConfig; vault: VaultConfig; store: StoreConfig };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serveSection(raw: unknown): ServeConfig {
  if (raw === undefined) {
    return {};
  }
  // A present-but-wrong-shaped section (`serve = 5`) is a problem, not silence.
  if (!isTable(raw)) {
    return { problem: 'malformed' };
  }
  const port = raw.port;
  // No port key at all — not a problem, caller uses the default.
  if (port === undefined) {
    return {};
  }
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
    return { port };
  }
  return { problem: 'invalid-port' };
}

function vaultSection(raw: unknown): VaultConfig {
  if (raw === undefined) {
    return {};
  }
  // `vault = "/path"` (a string, not a table) must surface, not silently
  // fall through to the default vault — the silent-wrong-vault trap.
  if (!isTable(raw)) {
    return { problem: 'malformed' };
  }
  const path = raw.path;
  if (path === undefined) {
    return {};
  }
  if (typeof path === 'string' && path !== '') {
    return { path };
  }
  return { problem: 'invalid-path' };
}

/**
 * Read the global config in one parse. Tolerant by design: a missing,
 * malformed, or wrong-typed file never throws — the loud-failure posture
 * belongs to the consumer (the port bind, the vault open), not the parse.
 * When a section is present but contributed nothing, its `problem` is set so
 * the consumer can warn that the config was ignored rather than silently
 * falling through to a default.
 */
function storeSection(raw: unknown): StoreConfig {
  if (raw === undefined) {
    return {};
  }
  if (!isTable(raw)) {
    return { problem: 'malformed' };
  }
  const artifacts = raw.artifacts;
  if (artifacts === undefined) {
    return {};
  }
  if (artifacts === 'sqlite' || artifacts === 'norn') {
    return { artifacts };
  }
  return { problem: 'invalid-artifacts' };
}

export function readConfig(file = configPath()): GlobalConfig {
  if (!existsSync(file)) {
    return { serve: {}, store: {}, vault: {} };
  }
  let parsed: { serve?: unknown; vault?: unknown; store?: unknown };
  try {
    parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
      serve?: unknown;
      vault?: unknown;
      store?: unknown;
    };
  } catch {
    return {
      serve: { problem: 'malformed' },
      store: { problem: 'malformed' },
      vault: { problem: 'malformed' },
    };
  }
  return {
    serve: serveSection(parsed.serve),
    store: storeSection(parsed.store),
    vault: vaultSection(parsed.vault),
  };
}

/** The `[serve]` section — see {@link readConfig} for the tolerance contract. */
export function readServeConfig(file = configPath()): ServeConfig {
  return readConfig(file).serve;
}

/** The `[vault]` section (MMR-142) — see {@link readConfig} for the tolerance contract. */
export function readVaultConfig(file = configPath()): VaultConfig {
  return readConfig(file).vault;
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
