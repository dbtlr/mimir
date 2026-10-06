/**
 * The global config (MMR-47) — the stable, declared source for daemon
 * settings, `[serve] port` first. The plist never carries a port: the daemon
 * reads this file at startup, so retargeting is edit-config + restart.
 * Serve's port precedence: --port > MIMIR_PORT > config > built-in default.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runtimePaths } from '../env';
import { isBindAddress, normalizeServeUrl } from './address';

/** A `[serve]` key, or the whole section, that was present but ignored. */
export type ServeProblem =
  | 'malformed'
  | 'invalid-port'
  | 'invalid-hosts'
  | 'invalid-bind'
  | 'invalid-url';

export type ServeConfig = {
  port?: number;
  /**
   * Hostnames `serve` answers beside the loopback names (MMR-425). Absent,
   * `serve` answers any Host (MMR-432); empty, the loopback names only.
   */
  hosts?: string[];
  /** The IP literal `serve` listens on (MMR-433); absent, loopback only. */
  bind?: string;
  /** The console's public origin, printed in place of the bound address (MMR-433). */
  url?: string;
  /** One entry per ignored key, or the whole section — callers warn on every one. */
  problems?: ServeProblem[];
};

/** Installation-bound path. Explicit bases are for isolated configuration tools. */
export function configPath(configHome?: string): string {
  return configHome === undefined
    ? join(runtimePaths().config, 'config.toml')
    : join(configHome, 'mimir', 'config.toml');
}

/** Every store backend a mimir install can run on (ADR 0030, ADR 0032). */
export type StoreBackend = 'sqlite' | 'postgres';

/** The backend an install runs on when `[store] backend` is absent: the local tier (ADR 0032). */
export const DEFAULT_STORE_BACKEND: StoreBackend = 'sqlite';

/**
 * The `[store]` section — the per-install backend fence, restored at MMR-378
 * (ADR 0030 Decision 1) after its MMR-234 retirement. `backend` selects `sqlite`
 * (the local database file, and the default when the key is absent, ADR 0032)
 * or `postgres`. `norn`, the markdown-vault backend ADR 0032 removed, is its own
 * problem so the refusal can name the way off it.
 * The fence is per install, NEVER per project: the working-set load is
 * deliberately whole-store because dependency edges cross project boundaries,
 * so one install is wholly on one backend. An unrecognized backend word is
 * `invalid-backend`, not a silent fallback — a typo must never quietly open a
 * different store than the operator named.
 */
export type StoreConfig = {
  backend?: StoreBackend;
  /** The Postgres connection URL (`postgres://user:pass@host/db`) — required by
   * the `postgres` backend, ignored by the others. The secret lives in this file on
   * purpose (ADR 0030): one install, one database, no env indirection. */
  url?: string;
  /** Set when a config file exists but contributed nothing — callers may warn. */
  problem?: 'invalid-backend' | 'invalid-url' | 'malformed' | 'removed-backend';
};

export type GlobalConfig = { serve: ServeConfig; store: StoreConfig };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serveSection(raw: unknown): ServeConfig {
  if (raw === undefined) {
    return {};
  }
  // A present-but-wrong-shaped section (`serve = 5`) is a problem, not silence.
  if (!isTable(raw)) {
    return { problems: ['malformed'] };
  }
  // Each key stands alone: a bad one is ignored and reported, never taking a
  // valid neighbor down with it. An absent key is not a problem.
  const serve: ServeConfig = {};
  const problems: ServeProblem[] = [];
  const port = raw.port;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
    serve.port = port;
  } else if (port !== undefined) {
    problems.push('invalid-port');
  }
  // A present-but-invalid `hosts` fails closed to loopback only: the operator
  // asked for the Host check, so a typo must not quietly turn it off.
  const hosts = raw.hosts;
  if (Array.isArray(hosts) && hosts.every(isHostName)) {
    serve.hosts = hosts;
  } else if (hosts !== undefined) {
    serve.hosts = [];
    problems.push('invalid-hosts');
  }
  // An invalid `bind` falls back to loopback, the narrower exposure.
  const bind = raw.bind;
  if (isBindAddress(bind)) {
    serve.bind = bind;
  } else if (bind !== undefined) {
    problems.push('invalid-bind');
  }
  const url = normalizeServeUrl(raw.url);
  if (url !== undefined) {
    serve.url = url;
  } else if (raw.url !== undefined) {
    problems.push('invalid-url');
  }
  if (problems.length > 0) {
    serve.problems = problems;
  }
  return serve;
}

/** A bare hostname or bracketed IPv6 literal — a port here would be ignored, so it is refused. */
function isHostName(value: unknown): value is string {
  return typeof value === 'string' && /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)$/i.test(value);
}

/**
 * The warning for a `[serve]` problem: a malformed section is ignored whole, a
 * bad key alone, and a bad `hosts` narrows `serve` to the loopback names.
 */
export function serveProblemWarning(problem: ServeProblem): string {
  if (problem === 'malformed') {
    return 'config ignored (malformed)';
  }
  return problem === 'invalid-hosts'
    ? 'config key invalid (hosts) — answering loopback names only'
    : `config key ignored (${problem})`;
}

function isStoreBackend(value: unknown): value is StoreBackend {
  return value === 'sqlite' || value === 'postgres';
}

function storeSection(raw: unknown): StoreConfig {
  if (raw === undefined) {
    return {};
  }
  // `store = "sqlite"` (a string, not a table) must surface, not silently fall
  // through to the default backend — the silent-wrong-store trap.
  if (!isTable(raw)) {
    return { problem: 'malformed' };
  }
  const backend = raw.backend;
  if (backend === 'norn') {
    return { problem: 'removed-backend' };
  }
  if (backend !== undefined && !isStoreBackend(backend)) {
    return { problem: 'invalid-backend' };
  }
  const url = raw.url;
  // A wrong-typed or empty url is the silent-wrong-store trap in another key:
  // a Postgres install that cannot connect must not quietly open a local store.
  if (url !== undefined && !(typeof url === 'string' && url !== '')) {
    return { problem: 'invalid-url' };
  }
  // No backend key at all is not a problem — the caller uses the default.
  return {
    ...(backend === undefined ? {} : { backend }),
    ...(url === undefined ? {} : { url }),
  };
}

/**
 * Read the global config in one parse. Tolerant by design: a missing,
 * malformed, or wrong-typed file never throws — the loud-failure posture
 * belongs to the consumer (the port bind, the store open), not the parse.
 * When a section or a key in it is present but ignored, the section says so
 * (`[serve]` lists every such key in `problems`; `[store]` names its one
 * `problem`) so the consumer can warn rather than silently falling through to
 * a default.
 */
export function readConfig(file = configPath()): GlobalConfig {
  if (!existsSync(file)) {
    return { serve: {}, store: {} };
  }
  let parsed: { serve?: unknown; store?: unknown };
  try {
    parsed = Bun.TOML.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      serve: { problems: ['malformed'] },
      store: { problem: 'malformed' },
    };
  }
  return {
    serve: serveSection(parsed.serve),
    store: storeSection(parsed.store),
  };
}

/**
 * Whether the config file exists but is not TOML at all — the one state
 * {@link writeConfig} resets rather than merges. Distinct from a parsed file
 * whose sections are merely wrong-shaped, which {@link readConfig} also reports
 * as `malformed`.
 */
export function isUnparseableConfig(file = configPath()): boolean {
  if (!existsSync(file)) {
    return false;
  }
  try {
    Bun.TOML.parse(readFileSync(file, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

/** Read only the installation or sandbox configuration selected by configPath. */
export function readRuntimeConfig(file = configPath()): GlobalConfig {
  return readConfig(file);
}

/** The `[serve]` section — see {@link readConfig} for the tolerance contract. */
export function readServeConfig(file = configPath()): ServeConfig {
  return readConfig(file).serve;
}

/** A change to apply over the current config — only the named keys are touched. */
export type ConfigPatch = {
  serve?: { port?: number };
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

/**
 * Owner-only. The config carries `[store] url`, a Postgres connection string
 * with its password in it, so the file is a credential file and is written as
 * one.
 */
const CONFIG_MODE = 0o600;

/** Owner-only, so no other user can rename a config of their own into place. */
const CONFIG_DIR_MODE = 0o700;

/**
 * The config file's permission bits (`0o644`), or undefined when it cannot be
 * statted. Lives here because doctor stays off `node:fs`.
 */
export function configFileMode(file = configPath()): number | undefined {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** One path on the way to the config: who owns it and its permission bits, sticky bit included. */
export type ConfigPathStat = {
  path: string;
  mode: number;
  uid: number;
  isDirectory: boolean;
};

/** A stat plus its filesystem identity, so one directory reached by two names is checked once. */
type ChainEntry = { stat: ConfigPathStat; id: string };

/** `path` and each directory above it, up to and including `stop` or `/`; stops at the first path it cannot stat. */
function statChain(path: string, stop: string): ChainEntry[] {
  const chain: ChainEntry[] = [];
  try {
    for (;;) {
      const s = statSync(path);
      chain.push({
        id: `${s.dev}:${s.ino}`,
        stat: { isDirectory: s.isDirectory(), mode: s.mode & 0o7777, path, uid: s.uid },
      });
      const parent = dirname(path);
      if (path === stop || parent === path) {
        return chain;
      }
      path = parent;
    }
  } catch {
    // A missing file, or a path removed mid-walk; what was statted is still checked.
    return chain;
  }
}

/** `path` with every symlink resolved, or `path` itself when it cannot be resolved. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The config file, then each directory above it, up to and including `home`,
 * or up to `/` when the file sits outside it. Whoever can rename any of these
 * can swap the config, so doctor checks every one (OpenSSH `StrictModes` walks
 * the same path). When symlinks are involved, the same walk from the file's real
 * location follows, each directory listed once. Empty when the file cannot be
 * statted. Lives here because doctor stays off `node:fs`.
 */
export function configPathStats(file = configPath(), home = homedir()): ConfigPathStat[] {
  const named = statChain(resolve(file), resolve(home));
  if (named.length === 0) {
    return [];
  }
  const seen = new Set(named.map((entry) => entry.id));
  const real = statChain(realOrSelf(file), realOrSelf(home)).filter((entry) => !seen.has(entry.id));
  return [...named, ...real].map((entry) => entry.stat);
}

/** The outcome of {@link writeConfig}: whether an unparseable file was reset. */
export type WriteResult = {
  /** True when the existing file was not valid TOML and was rewritten fresh (lossy). */
  reset: boolean;
};

/**
 * Merge a patch into the config and rewrite it whole. Operates on the RAW parsed
 * TOML, not the tolerant {@link readConfig} projection, so a section the patch
 * doesn't name survives verbatim — including a reader-rejected value, or a
 * table no reader knows (a `[vault]` left from the removed Norn backend).
 * Comments and blank-line grouping are not preserved (the config is
 * tool-managed).
 *
 * A file that isn't valid TOML can't be merged into, so it is treated as absent
 * and overwritten (the prior whole-file writer clobbered unconditionally; this
 * is no worse, and it keeps setup — the repair path — from stranding an install
 * behind a hard failure). That reset is LOSSY, so it is reported via
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
  const out: string[] = [];
  emitTable('', raw, out);
  // Owner-only, like the file: doctor warns on a directory others can write.
  mkdirSync(dirname(file), { mode: CONFIG_DIR_MODE, recursive: true });
  writeFileSync(file, out.length === 0 ? '' : `${out.join('\n\n')}\n`, { mode: CONFIG_MODE });
  // `mode` on `writeFileSync` applies only when the file is CREATED, so an
  // existing file keeps whatever permissions it had. `chmod` after the write
  // tightens that one too: the file carries `[store] url`, credentials and all,
  // and an operator who upgrades into this version should not have to know.
  chmodSync(file, CONFIG_MODE);
  return { reset };
}

/**
 * Write the serve port (the `service install --port` discovery path), merging
 * so other sections survive. Returns the same {@link WriteResult} as
 * {@link writeConfig} so the caller can warn on a reset.
 */
export function writeServePort(file: string, port: number): WriteResult {
  return writeConfig(file, { serve: { port } });
}
