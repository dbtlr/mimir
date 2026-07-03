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
  /**
   * `path` merges into `[vault]`; `snapshot`, when present, REPLACES the whole
   * `[vault.snapshot]` table (an empty object clears it) — so a reconfiguration
   * can drop a key like `upstream`, which a per-key merge could never express.
   */
  vault?: { path?: string; snapshot?: SnapshotConfig };
  store?: { artifacts?: 'sqlite' | 'norn' };
};

type Table = Record<string, unknown>;

/** A shallow copy of a value when it is a table, else a fresh empty table. */
function asTable(value: unknown): Table {
  return isTable(value) ? { ...value } : {};
}

/** A TOML bare key needs no quoting; anything else is emitted as a quoted key. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
function emitKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/** A number as TOML — with the `inf`/`nan` spellings TOML uses for non-finites. */
function emitNumber(value: number): string {
  if (Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isNaN(value)) {
    return 'nan';
  }
  return value > 0 ? 'inf' : '-inf';
}

/**
 * Emit one TOML value, losslessly — every kind `Bun.TOML.parse` produces:
 * strings (via JSON's escaping, a valid TOML basic string), numbers (with the
 * non-finite forms TOML spells `inf`/`nan`), booleans, datetimes, arrays
 * (elements recursed, so an array of inline tables survives), and inline tables
 * (keys quoted when they aren't bare). Nothing is filtered or emitted unquoted,
 * so a rewrite can never turn preserved content into invalid TOML.
 */
function emitValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return emitNumber(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(emitValue).join(', ')}]`;
  }
  if (isTable(value)) {
    const inner = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${emitKey(k)} = ${emitValue(v)}`)
      .join(', ');
    return inner === '' ? '{}' : `{ ${inner} }`;
  }
  // Unreachable for TOML-parsed input; a plain coercion keeps it from vanishing.
  return String(value);
}

/**
 * Serialize a raw TOML table, recursing into sub-tables. Scalars precede
 * sub-tables at every level (TOML requires it — bare keys belong to the
 * enclosing table); an empty table emits no header, so a section cleared to
 * nothing simply disappears. Keys (scalar keys and each header segment) are
 * quoted when they aren't bare, so the output is always valid TOML.
 */
function emitTable(prefix: string, table: Table, out: string[]): void {
  const scalars: string[] = [];
  const subTables: [string, Table][] = [];
  for (const [key, value] of Object.entries(table)) {
    if (value === undefined) {
      continue;
    }
    // A nested table becomes a `[section]`; a Date is `typeof 'object'` too, so
    // it is excluded here and emitted as a scalar. Everything else (primitives,
    // arrays) is a scalar-position value.
    if (isTable(value) && !(value instanceof Date)) {
      subTables.push([key, value]);
    } else {
      scalars.push(`${emitKey(key)} = ${emitValue(value)}`);
    }
  }
  if (scalars.length > 0) {
    out.push(prefix === '' ? scalars.join('\n') : `[${prefix}]\n${scalars.join('\n')}`);
  }
  for (const [key, sub] of subTables) {
    emitTable(prefix === '' ? emitKey(key) : `${prefix}.${emitKey(key)}`, sub, out);
  }
}

/** The outcome of {@link writeConfig}: whether an unparseable file was reset. */
export type WriteResult = {
  /** True when the existing file was not valid TOML and was rewritten fresh (lossy). */
  reset: boolean;
};

/**
 * Merge a patch into the config and rewrite it whole. Operates on the RAW parsed
 * TOML, not the tolerant {@link readConfig} projection, so a section the patch
 * doesn't name survives verbatim — including a reader-rejected value (an invalid
 * `[vault.snapshot]` key is not silently erased when an unrelated `[serve] port`
 * is written). Comments and blank-line grouping are not preserved (the config is
 * tool-managed).
 *
 * A file that isn't valid TOML can't be merged into, so it is treated as absent
 * and overwritten (the prior whole-file writer clobbered unconditionally; this
 * is no worse, and it keeps setup — the repair path — from stranding a converged
 * vault behind a hard failure). That reset is LOSSY, so it is reported via
 * `reset: true`; every caller must surface it (it is not silent).
 */
export function writeConfig(file: string, patch: ConfigPatch): WriteResult {
  let raw: Table = {};
  let reset = false;
  if (existsSync(file)) {
    try {
      raw = asTable(Bun.TOML.parse(readFileSync(file, 'utf8')));
    } catch {
      reset = true; // unparseable — can't merge; the write below overwrites it
    }
  }
  if (patch.serve?.port !== undefined) {
    raw.serve = { ...asTable(raw.serve), port: patch.serve.port };
  }
  if (patch.vault !== undefined) {
    const vault = asTable(raw.vault);
    if (patch.vault.path !== undefined) {
      vault.path = patch.vault.path;
    }
    if (patch.vault.snapshot !== undefined) {
      vault.snapshot = { ...patch.vault.snapshot };
    }
    raw.vault = vault;
  }
  if (patch.store?.artifacts !== undefined) {
    raw.store = { ...asTable(raw.store), artifacts: patch.store.artifacts };
  }
  const out: string[] = [];
  emitTable('', raw, out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out.length === 0 ? '' : `${out.join('\n\n')}\n`);
  return { reset };
}

/**
 * Write the serve port (the `service install --port` discovery path), merging
 * so other sections survive — the second key the original whole-file writer
 * anticipated has arrived (setup writes `[vault] path`). Returns the same
 * {@link WriteResult} as {@link writeConfig} so the caller can warn on a reset.
 */
export function writeServePort(file: string, port: number): WriteResult {
  return writeConfig(file, { serve: { port } });
}
