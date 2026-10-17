/**
 * The CLI's global config: the `[store]` section that selects this install's
 * backend. The file is operator-edited; nothing in mimir writes it.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runtimePaths } from './env';

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

export type GlobalConfig = { store: StoreConfig };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * belongs to the consumer (the store open), not the parse. When the section or
 * a key in it is present but ignored, `[store]` names its one `problem` so the
 * consumer can warn rather than silently falling through to a default. Any
 * other section, a leftover `[serve]` included, is ignored.
 */
export function readConfig(file = configPath()): GlobalConfig {
  if (!existsSync(file)) {
    return { store: {} };
  }
  let parsed: { store?: unknown };
  try {
    parsed = Bun.TOML.parse(readFileSync(file, 'utf8'));
  } catch {
    return { store: { problem: 'malformed' } };
  }
  return { store: storeSection(parsed.store) };
}

/** Read only the installation or sandbox configuration selected by configPath. */
export function readRuntimeConfig(file = configPath()): GlobalConfig {
  return readConfig(file);
}

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
