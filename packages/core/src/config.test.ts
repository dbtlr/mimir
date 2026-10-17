import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configPath,
  configPathStats,
  DEFAULT_STORE_BACKEND,
  readConfig,
  readRuntimeConfig,
} from './config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-config-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

// Fix 2 — rename existing test to match what it actually tests (explicit param)
test('configPath resolves under the given XDG base', () => {
  expect(configPath(dir)).toBe(join(dir, 'mimir', 'config.toml'));
});

// Fix 2 — new test that exercises the env-var path
test('uninstalled config ignores ambient live XDG_CONFIG_HOME', () => {
  const original = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = dir;
    expect(configPath()).toEndWith('/.dev/config/mimir/config.toml');
  } finally {
    if (original === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = original;
    }
  }
});

test('a missing file reads as an empty config', () => {
  expect(readConfig(join(dir, 'nope', 'config.toml'))).toEqual({ store: {} });
});

test('readConfig reads the [store] section', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "postgres"\n');
  expect(readConfig(file)).toEqual({ store: { backend: 'postgres' } });
});

// The CLI no longer serves, so a `[serve]` section left in an existing config
// is neither read nor reported.
test('readConfig ignores a leftover [serve] section, valid or not', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(
    file,
    '[serve]\nport = 50124\nhosts = "x"\nbind = 5\n[store]\nbackend = "postgres"\n',
  );
  expect(readConfig(file)).toEqual({ store: { backend: 'postgres' } });
  writeFileSync(file, 'serve = 5\n');
  expect(readConfig(file)).toEqual({ store: {} });
});

// ADR 0032 removed the markdown-vault backend. A config written for it keeps
// its `[vault]` table, which no reader knows: it is ignored, never a problem.
test('readConfig ignores a leftover [vault] table', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\n');
  expect(readConfig(file)).toEqual({ store: {} });
});

test('runtime reads an explicitly selected isolated configuration', () => {
  const file = join(dir, 'sandbox.toml');
  writeFileSync(file, '[store]\nbackend = "postgres"\n');
  expect(readRuntimeConfig(file).store).toEqual({ backend: 'postgres' });
});

// The `[store] backend` fence is back per install (ADR 0030 Decision 1,
// MMR-378): absent means `sqlite` (ADR 0032), a named backend is carried
// through, and an unrecognized word is flagged rather than silently opening
// another store.
test('readConfig defaults an absent [store] backend to sqlite at the consumer', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '');
  expect(readConfig(file).store).toEqual({});
  expect(readConfig(file).store.backend ?? DEFAULT_STORE_BACKEND).toBe('sqlite');
});

test('readConfig carries each known [store] backend', () => {
  const file = join(dir, 'config.toml');
  for (const backend of ['sqlite', 'postgres'] as const) {
    writeFileSync(file, `[store]\nbackend = "${backend}"\n`);
    expect(readConfig(file).store).toEqual({ backend });
  }
});

test('readConfig flags an unrecognized or wrong-shaped [store] backend', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "mysql"\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-backend' });
  writeFileSync(file, '[store]\nbackend = 7\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-backend' });
  // a non-table `store` is malformed, not a silent default
  writeFileSync(file, 'store = "sqlite"\n');
  expect(readConfig(file).store).toEqual({ problem: 'malformed' });
  // an unparseable file marks every section, this one included
  writeFileSync(file, 'not = = toml\n');
  expect(readConfig(file).store).toEqual({ problem: 'malformed' });
});

// The removed backend is its own problem, distinct from a typo, so the refusal
// can name the way off it (ADR 0032).
test('readConfig flags the removed norn backend as removed-backend', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "norn"\n');
  expect(readConfig(file).store).toEqual({ problem: 'removed-backend' });
});

test('readConfig carries a [store] url alongside the backend', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "postgres"\nurl = "postgres://mimir@db.local/mimir"\n');
  expect(readConfig(file).store).toEqual({
    backend: 'postgres',
    url: 'postgres://mimir@db.local/mimir',
  });
  // The url is carried on its own too: the backend fence decides whether it is needed.
  writeFileSync(file, '[store]\nurl = "postgres://mimir@db.local/mimir"\n');
  expect(readConfig(file).store).toEqual({ url: 'postgres://mimir@db.local/mimir' });
});

test('readConfig flags a wrong-shaped [store] url rather than dropping it', () => {
  // A Postgres install whose url is unusable must not quietly open the default
  // local store instead — the same silent-wrong-store trap the backend word guards.
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "postgres"\nurl = 7\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-url' });
  writeFileSync(file, '[store]\nbackend = "postgres"\nurl = ""\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-url' });
});

test('an unknown key inside [store] stays an unknown-key no-op', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nartifacts = "files"\n');
  expect(readConfig(file).store).toEqual({});
});

test('configPathStats walks the file and each directory up to and including home', () => {
  const nest = join(dir, 'config', 'mimir');
  mkdirSync(nest, { recursive: true });
  const file = join(nest, 'config.toml');
  writeFileSync(file, '');
  chmodSync(file, 0o600);
  chmodSync(nest, 0o1777);
  const stats = configPathStats(file, dir);
  expect(stats.map((s) => s.path)).toEqual([file, nest, join(dir, 'config'), dir]);
  expect(stats.map((s) => s.isDirectory)).toEqual([false, true, true, true]);
  // The sticky bit survives: it decides whether a writable directory is safe.
  expect(stats[0]?.mode).toBe(0o600);
  expect(stats[1]?.mode).toBe(0o1777);
  expect(stats.every((s) => s.uid === statSync(dir).uid)).toBe(true);
});

test('configPathStats walks to the root when the file sits outside home', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '');
  const stats = configPathStats(file, join(dir, 'elsewhere'));
  expect(stats.map((s) => s.path)).toContain('/');
  expect(stats.map((s) => s.path)).toContain(dir);
});

test('configPathStats is empty when the config file does not exist', () => {
  expect(configPathStats(join(dir, 'config.toml'), dir)).toEqual([]);
});

test('configPathStats also walks the real location of a symlinked config', () => {
  // A dotfile manager links the config elsewhere; whoever can rename entries
  // along the target's path can swap the config as surely as along the link's.
  const real = realpathSync(dir);
  const shared = join(real, 'shared');
  const linked = join(real, 'home', 'mimir');
  mkdirSync(shared);
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(shared, 'config.toml'), '');
  const file = join(linked, 'config.toml');
  symlinkSync(join(shared, 'config.toml'), file);
  const paths = configPathStats(file, join(real, 'home')).map((s) => s.path);
  expect(paths.slice(0, 3)).toEqual([file, linked, join(real, 'home')]);
  expect(paths).toContain(shared);
  // The link already stats as its target, so the file is listed once, by the
  // name doctor opens; so is every directory both walks reach.
  expect(paths).not.toContain(join(shared, 'config.toml'));
  expect(paths.filter((p) => p === real)).toHaveLength(1);
});
