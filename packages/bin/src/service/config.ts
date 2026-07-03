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

/**
 * The `[vault.snapshot]` sub-table (MMR-146) — the vault's git commit cadence.
 * Every key is optional; the snapshot command supplies defaults (interval 900s,
 * push/pull on) for whatever the operator leaves unset.
 */
export type SnapshotConfig = {
  /** Seconds between scheduled snapshots — baked into the launchd StartInterval. */
  interval?: number;
  /** Remote URL to push to / reconcile against when no upstream is configured on the branch. */
  upstream?: string;
  /** Push after committing (default on). Off = purely local, durable snapshots. */
  push?: boolean;
  /** Reconcile (fetch + merge) when a push is rejected (default on). Off = a rejected push fails loud. */
  pull?: boolean;
};

export type VaultConfig = {
  path?: string;
  snapshot?: SnapshotConfig;
  /** Set when a config file exists but contributed nothing — callers may warn. */
  problem?: 'malformed' | 'invalid-path' | 'invalid-snapshot';
};

/** The snapshot cadence when `[vault.snapshot] interval` is unset — the atlas precedent, 15 minutes. */
export const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 900;

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
  // A wrong-typed path is the silent-wrong-vault trap — reject it outright,
  // ahead of the snapshot sub-table (an operator can't act on the cadence of a
  // vault that won't open).
  if (path !== undefined && !(typeof path === 'string' && path !== '')) {
    return { problem: 'invalid-path' };
  }
  const validPath = typeof path === 'string' ? { path } : {};
  const snapshot = snapshotSection(raw.snapshot);
  // A bad snapshot warns but never discards a good path: the vault still opens;
  // only the cadence is ignored (invalid-snapshot).
  if (snapshot === 'invalid') {
    return { ...validPath, problem: 'invalid-snapshot' };
  }
  return { ...validPath, ...(snapshot === undefined ? {} : { snapshot }) };
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

/**
 * Validate `[vault.snapshot]`: the whole sub-table is rejected as `'invalid'`
 * the moment any declared key is wrong-typed or out of range — coarse on
 * purpose, matching the section-level tolerance contract. Absent → undefined;
 * a table of only-good declared keys → that config.
 */
function snapshotSection(raw: unknown): SnapshotConfig | 'invalid' | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isTable(raw)) {
    return 'invalid';
  }
  const out: SnapshotConfig = {};
  if (raw.interval !== undefined) {
    if (!isPositiveInt(raw.interval)) {
      return 'invalid';
    }
    out.interval = raw.interval;
  }
  if (raw.upstream !== undefined) {
    if (!(typeof raw.upstream === 'string' && raw.upstream !== '')) {
      return 'invalid';
    }
    out.upstream = raw.upstream;
  }
  if (raw.push !== undefined) {
    if (typeof raw.push !== 'boolean') {
      return 'invalid';
    }
    out.push = raw.push;
  }
  if (raw.pull !== undefined) {
    if (typeof raw.pull !== 'boolean') {
      return 'invalid';
    }
    out.pull = raw.pull;
  }
  return out;
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

/** A change to apply over the current config — only the named keys are touched. */
export type ConfigPatch = {
  serve?: { port?: number };
  vault?: { path?: string; snapshot?: SnapshotConfig };
  store?: { artifacts?: 'sqlite' | 'norn' };
};

/** A TOML basic string — JSON's escaping is a valid encoding for our values. */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Render the known config schema. Section order is fixed and `[vault]` scalar
 * keys precede the `[vault.snapshot]` sub-table, as TOML requires. A section
 * with nothing to say is omitted rather than emitted empty.
 */
function serializeConfig(config: GlobalConfig): string {
  const sections: string[] = [];
  if (config.serve.port !== undefined) {
    sections.push(`[serve]\nport = ${String(config.serve.port)}`);
  }
  if (config.vault.path !== undefined) {
    sections.push(`[vault]\npath = ${tomlString(config.vault.path)}`);
  }
  const snap = config.vault.snapshot;
  if (snap !== undefined) {
    const keys: string[] = [];
    if (snap.interval !== undefined) {
      keys.push(`interval = ${String(snap.interval)}`);
    }
    if (snap.upstream !== undefined) {
      keys.push(`upstream = ${tomlString(snap.upstream)}`);
    }
    if (snap.push !== undefined) {
      keys.push(`push = ${String(snap.push)}`);
    }
    if (snap.pull !== undefined) {
      keys.push(`pull = ${String(snap.pull)}`);
    }
    if (keys.length > 0) {
      sections.push(`[vault.snapshot]\n${keys.join('\n')}`);
    }
  }
  if (config.store.artifacts !== undefined) {
    sections.push(`[store]\nartifacts = ${tomlString(config.store.artifacts)}`);
  }
  return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}

/**
 * Merge a patch into the config and rewrite it whole — preserving every section
 * the patch doesn't name (the `service install --port` path must not drop a
 * `[vault] path`, and setup writes both). Reads through {@link readConfig}, so a
 * value the reader rejected as invalid is not carried forward; the write is a
 * clean, normalized config.
 */
export function writeConfig(file: string, patch: ConfigPatch): void {
  const current = readConfig(file);
  const mergedSnapshot =
    patch.vault?.snapshot !== undefined || current.vault.snapshot !== undefined
      ? { ...current.vault.snapshot, ...patch.vault?.snapshot }
      : undefined;
  const merged: GlobalConfig = {
    serve: { port: patch.serve?.port ?? current.serve.port },
    store: { artifacts: patch.store?.artifacts ?? current.store.artifacts },
    vault: {
      path: patch.vault?.path ?? current.vault.path,
      ...(mergedSnapshot === undefined ? {} : { snapshot: mergedSnapshot }),
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeConfig(merged));
}

/**
 * Write the serve port (the `service install --port` discovery path), merging
 * so other sections survive — the second key the original whole-file writer
 * anticipated has arrived (setup writes `[vault] path`).
 */
export function writeServePort(file: string, port: number): void {
  writeConfig(file, { serve: { port } });
}
