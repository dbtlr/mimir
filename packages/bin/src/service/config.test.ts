import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  readServeConfig,
  writeConfig,
  writeServePort,
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

test('missing file reads as empty config', () => {
  expect(readServeConfig(join(dir, 'nope', 'config.toml'))).toEqual({});
});

test('reads [serve] port', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50123\n');
  expect(readServeConfig(file)).toEqual({ port: 50123 });
});

// Fix 3 + updated assertions for Fix 1
test("malformed TOML reports { problem: 'malformed' } and wrong-typed port reports { problem: 'invalid-port' }", () => {
  const file = join(dir, 'config.toml');
  // Fix 3 — malformed TOML
  writeFileSync(file, '[serve\nport = ???');
  expect(readServeConfig(file)).toEqual({ problem: 'malformed' });
  // Fix 3 — wrong-typed string port
  writeFileSync(file, '[serve]\nport = "high"\n');
  expect(readServeConfig(file)).toEqual({ problem: 'invalid-port' });
});

// Fix 3 — boundary coverage: 0, 65536, 1.5 each yield { problem: "invalid-port" }
test("port boundary values 0, 65536, and 1.5 each yield { problem: 'invalid-port' }", () => {
  const file = join(dir, 'config.toml');
  for (const bad of [0, 65536, 1.5]) {
    writeFileSync(file, `[serve]\nport = ${bad}\n`);
    const result = readServeConfig(file);
    expect(result).not.toHaveProperty('port');
    expect(result).toEqual({ problem: 'invalid-port' });
  }
});

// Fix 1 — config with no serve.port at all is not a problem
test('config with no [serve] port reads as empty (not a problem)', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\n');
  expect(readServeConfig(file)).toEqual({});
});

test('reads [serve] hosts beside the port', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50123\nhosts = ["mimir.example.test"]\n');
  expect(readServeConfig(file)).toEqual({ hosts: ['mimir.example.test'], port: 50123 });
});

test('a hosts value that is not a list of names is a problem that keeps the valid port', () => {
  const file = join(dir, 'config.toml');
  for (const bad of [
    '"mimir.example.test"',
    '[1]',
    '[""]',
    '["mimir.example.test:443"]',
    '["*"]',
    '["a/b"]',
  ]) {
    writeFileSync(file, `[serve]\nport = 50123\nhosts = ${bad}\n`);
    expect(readServeConfig(file)).toEqual({ port: 50123, problem: 'invalid-hosts' });
  }
});

test('writeServePort keeps the configured hosts', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nhosts = ["mimir.example.test"]\n');
  writeServePort(file, 50124);
  expect(readServeConfig(file)).toEqual({ hosts: ['mimir.example.test'], port: 50124 });
});

test('writeServePort creates parents and round-trips', () => {
  const file = join(dir, 'deep', 'mimir', 'config.toml');
  writeServePort(file, 50124);
  expect(readFileSync(file, 'utf8')).toBe('[serve]\nport = 50124\n');
  expect(readServeConfig(file)).toEqual({ port: 50124 });
});

test('a present-but-wrong-shaped section is malformed, never silence', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'serve = 5\n');
  expect(readServeConfig(file)).toEqual({ problem: 'malformed' });
});

test('readConfig parses once and returns every section', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50124\n[store]\nbackend = "postgres"\n');
  expect(readConfig(file)).toEqual({
    serve: { port: 50124 },
    store: { backend: 'postgres' },
  });
});

// ADR 0032 removed the markdown-vault backend. A config written for it keeps
// its `[vault]` table, which no reader knows: it is ignored, never a problem.
test('readConfig ignores a leftover [vault] table', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(
    file,
    '[serve]\nport = 50124\n[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\n',
  );
  expect(readConfig(file)).toEqual({ serve: { port: 50124 }, store: {} });
});

test('runtime reads an explicitly selected isolated configuration', () => {
  const file = join(dir, 'sandbox.toml');
  writeFileSync(file, '[serve]\nport = 50130\n');
  expect(readRuntimeConfig(file).serve).toEqual({ port: 50130 });
});

// The `[store] backend` fence is back per install (ADR 0030 Decision 1,
// MMR-378): absent means `sqlite` (ADR 0032), a named backend is carried
// through, and an unrecognized word is flagged rather than silently opening
// another store.
test('readConfig defaults an absent [store] backend to sqlite at the consumer', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50124\n');
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

test('writeConfig creates parents and round-trips a serve port', () => {
  const file = join(dir, 'deep', 'mimir', 'config.toml');
  writeConfig(file, { serve: { port: 50132 } });
  expect(readConfig(file)).toEqual({ serve: { port: 50132 }, store: {} });
});

test('writeConfig leaves the config readable only by its owner', () => {
  // The file carries `[store] url`, which holds the Postgres password. A
  // world-readable credential file on a shared host is the credential leaked.
  const file = join(dir, 'config.toml');
  // A pre-existing loose file is TIGHTENED, not merely left alone: an operator
  // who upgrades into this version gets the fix without doing anything.
  writeFileSync(file, '', { mode: 0o644 });
  writeConfig(file, { serve: { port: 50133 } });
  expect(statSync(file).mode & 0o777).toBe(0o600);

  const fresh = join(dir, 'fresh', 'config.toml');
  writeConfig(fresh, { serve: { port: 50133 } });
  expect(statSync(fresh).mode & 0o777).toBe(0o600);
});

test('writeConfig creates missing directories owner-only, whatever the umask', () => {
  // A 0775 directory from a umask-002 shell would trip doctor's own
  // config-dir-writable warning on a directory mimir made.
  const previous = process.umask(0o002);
  try {
    writeConfig(join(dir, 'a', 'b', 'config.toml'), { serve: { port: 50133 } });
  } finally {
    process.umask(previous);
  }
  expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
});

test('writeConfig preserves a leftover [vault] table verbatim', () => {
  // No reader knows `[vault]` since ADR 0032, but the writer works on the raw
  // TOML, so a port write leaves the table (sub-tables included) as it was.
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\npush = false\n');
  writeServePort(file, 50125);
  expect(Bun.TOML.parse(readFileSync(file, 'utf8'))).toEqual({
    serve: { port: 50125 },
    vault: { path: '/v', snapshot: { interval: 900, push: false } },
  });
});

test('writeConfig preserves a reader-rejected value rather than erasing its section', () => {
  const file = join(dir, 'config.toml');
  // A hand-edited config whose [store] has one invalid value alongside a good
  // one. readConfig collapses the whole section to a problem; the writer must
  // NOT propagate that loss when an unrelated [serve] port is written.
  writeFileSync(file, '[store]\nbackend = "postgres"\nurl = 7\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-url' });
  writeServePort(file, 50128);
  expect(Bun.TOML.parse(readFileSync(file, 'utf8'))).toEqual({
    serve: { port: 50128 },
    store: { backend: 'postgres', url: 7 },
  });
});

test('writeConfig treats an unparseable file as absent, rewrites it, and reports reset', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[store]\nbackend = "postgres"\n[serve\nport = ???'); // broken TOML
  // Cannot merge into garbage — the write proceeds and overwrites it (matching
  // the prior whole-file writer), rather than throwing and stranding callers.
  // The loss is reported (reset) so callers can warn — it is never silent.
  expect(writeServePort(file, 50129)).toEqual({ reset: true });
  expect(readServeConfig(file)).toEqual({ port: 50129 });
});

test('writeConfig reports reset=false for a parseable (even wrong-typed) file', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'serve = 5\n[store]\nbackend = "postgres"\n'); // valid TOML, wrong-typed serve
  expect(writeConfig(file, { serve: { port: 50131 } })).toEqual({ reset: false });
  // The parseable store backend survives (merge, not clobber).
  expect(readConfig(file).store).toEqual({ backend: 'postgres' });
});

test('writeConfig preserves an unmanaged section with arrays, floats, and inline tables', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[extra]\ntags = ["a", "b"]\nratio = 1.5\nrows = [{ a = 1 }, { a = 2 }]\n');
  writeServePort(file, 50130);
  const round = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
    serve: { port: number };
    extra: { tags: string[]; ratio: number; rows: { a: number }[] };
  };
  expect(round.serve.port).toBe(50130);
  // The array of inline tables survives verbatim (not flattened to []).
  expect(round.extra).toEqual({ ratio: 1.5, rows: [{ a: 1 }, { a: 2 }], tags: ['a', 'b'] });
});

test('writeConfig emits quoted keys so a space-containing key stays valid TOML', () => {
  const file = join(dir, 'config.toml');
  // An array-of-tables element with a key that needs quoting, plus a quoted
  // top-level section key — the emitter must quote both, not corrupt the file.
  writeFileSync(file, '["a b"]\nx = 1\n[[m]]\n"src path" = "/a"\ndst = "/b"\n');
  writeServePort(file, 50131);
  // The rewritten file must still parse (a bare `src path =` would throw).
  const round = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
    serve: { port: number };
    'a b': { x: number };
    m: { 'src path': string; dst: string }[];
  };
  expect(round.serve.port).toBe(50131);
  expect(round['a b']).toEqual({ x: 1 });
  expect(round.m).toEqual([{ dst: '/b', 'src path': '/a' }]);
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
