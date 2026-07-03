import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configPath,
  readConfig,
  readServeConfig,
  readVaultConfig,
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
test('configPath uses XDG_CONFIG_HOME env var when set', () => {
  const original = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = dir;
    expect(configPath()).toBe(join(dir, 'mimir', 'config.toml'));
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

test('writeServePort creates parents and round-trips', () => {
  const file = join(dir, 'deep', 'mimir', 'config.toml');
  writeServePort(file, 50124);
  expect(readFileSync(file, 'utf8')).toBe('[serve]\nport = 50124\n');
  expect(readServeConfig(file)).toEqual({ port: 50124 });
});

test('readVaultConfig: missing file and missing key are empty; a path round-trips', () => {
  const file = join(dir, 'config.toml');
  expect(readVaultConfig(file)).toEqual({});
  writeFileSync(file, '[serve]\nport = 50124\n');
  expect(readVaultConfig(file)).toEqual({});
  writeFileSync(file, '[vault]\npath = "/Volumes/data/vaults/mimir"\n');
  expect(readVaultConfig(file)).toEqual({ path: '/Volumes/data/vaults/mimir' });
});

test('readVaultConfig: malformed file and wrong-typed path surface as problems', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'not toml [');
  expect(readVaultConfig(file)).toEqual({ problem: 'malformed' });
  writeFileSync(file, '[vault]\npath = 7\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-path' });
  writeFileSync(file, '[vault]\npath = ""\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-path' });
});

test('readVaultConfig: a full [vault.snapshot] table round-trips alongside path', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(
    file,
    '[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\nupstream = "git@example.com:me/vault.git"\npush = true\npull = false\n',
  );
  expect(readVaultConfig(file)).toEqual({
    path: '/v',
    snapshot: { interval: 900, pull: false, push: true, upstream: 'git@example.com:me/vault.git' },
  });
});

test('readVaultConfig: a partial [vault.snapshot] keeps only the declared keys', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault.snapshot]\ninterval = 300\n');
  expect(readVaultConfig(file)).toEqual({ snapshot: { interval: 300 } });
});

test('readVaultConfig: a bad snapshot value surfaces invalid-snapshot', () => {
  const file = join(dir, 'config.toml');
  // non-table snapshot
  writeFileSync(file, '[vault]\nsnapshot = 5\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-snapshot' });
  // non-positive / non-integer interval
  for (const bad of [0, -60, 1.5, '"900"']) {
    writeFileSync(file, `[vault.snapshot]\ninterval = ${String(bad)}\n`);
    expect(readVaultConfig(file)).toEqual({ problem: 'invalid-snapshot' });
  }
  // empty / non-string upstream
  writeFileSync(file, '[vault.snapshot]\nupstream = ""\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-snapshot' });
  writeFileSync(file, '[vault.snapshot]\nupstream = 7\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-snapshot' });
  // non-boolean toggles
  writeFileSync(file, '[vault.snapshot]\npush = "yes"\n');
  expect(readVaultConfig(file)).toEqual({ problem: 'invalid-snapshot' });
});

test('readVaultConfig: a valid path is kept even when snapshot is invalid (warn, do not discard)', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 0\n');
  expect(readVaultConfig(file)).toEqual({ path: '/v', problem: 'invalid-snapshot' });
});

test('a present-but-wrong-shaped section is malformed, never silence', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'vault = "/some/path"\n'); // a string, not a [vault] table
  expect(readVaultConfig(file)).toEqual({ problem: 'malformed' });
  writeFileSync(file, 'serve = 5\n');
  expect(readServeConfig(file)).toEqual({ problem: 'malformed' });
});

test('readConfig parses once and returns every section', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50124\n[vault]\npath = "/v"\n[store]\nartifacts = "norn"\n');
  expect(readConfig(file)).toEqual({
    serve: { port: 50124 },
    store: { artifacts: 'norn' },
    vault: { path: '/v' },
  });
});

test('readVaultConfig missing sections default empty; a wrong-typed store surfaces', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[serve]\nport = 50124\n');
  expect(readConfig(file).store).toEqual({});
  writeFileSync(file, '[store]\nartifacts = "postgres"\n');
  expect(readConfig(file).store).toEqual({ problem: 'invalid-artifacts' });
  writeFileSync(file, 'store = "norn"\n');
  expect(readConfig(file).store).toEqual({ problem: 'malformed' });
});

test('writeConfig creates parents and round-trips a vault path + snapshot', () => {
  const file = join(dir, 'deep', 'mimir', 'config.toml');
  writeConfig(file, {
    vault: { path: '/v', snapshot: { interval: 300, upstream: 'git@host:me/v.git' } },
  });
  expect(readConfig(file)).toEqual({
    serve: {},
    store: {},
    vault: { path: '/v', snapshot: { interval: 300, upstream: 'git@host:me/v.git' } },
  });
});

test('writeConfig merges: a serve-port write preserves an existing [vault] path', () => {
  const file = join(dir, 'config.toml');
  writeConfig(file, { vault: { path: '/v', snapshot: { interval: 900 } } });
  writeConfig(file, { serve: { port: 50125 } });
  expect(readConfig(file)).toEqual({
    serve: { port: 50125 },
    store: {},
    vault: { path: '/v', snapshot: { interval: 900 } },
  });
});

test('writeConfig replaces the snapshot table authoritatively (a key can be dropped)', () => {
  const file = join(dir, 'config.toml');
  writeConfig(file, {
    vault: { path: '/v', snapshot: { interval: 900, upstream: 'git@host:me/v.git' } },
  });
  // A subsequent snapshot write with no upstream clears it — the table is
  // replaced, not per-key merged (setup relies on this to drop an upstream).
  writeConfig(file, { vault: { snapshot: { interval: 1200 } } });
  expect(readVaultConfig(file)).toEqual({ path: '/v', snapshot: { interval: 1200 } });
});

test('writeConfig leaves the snapshot table untouched when the patch omits it', () => {
  const file = join(dir, 'config.toml');
  writeConfig(file, { vault: { path: '/v', snapshot: { interval: 900 } } });
  writeConfig(file, { serve: { port: 50127 } });
  expect(readVaultConfig(file)).toEqual({ path: '/v', snapshot: { interval: 900 } });
});

test('writeConfig preserves a reader-rejected value rather than erasing its section', () => {
  const file = join(dir, 'config.toml');
  // A hand-edited config whose snapshot has one invalid value alongside good
  // ones. readConfig would collapse the whole sub-table to a problem; the writer
  // must NOT propagate that loss when an unrelated [serve] port is written.
  writeFileSync(file, '[vault]\npath = "/v"\n[vault.snapshot]\ninterval = 900\npush = "no"\n');
  writeServePort(file, 50128);
  const round = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
    serve: { port: number };
    vault: { path: string; snapshot: { interval: number; push: string } };
  };
  expect(round.serve.port).toBe(50128);
  expect(round.vault.path).toBe('/v');
  expect(round.vault.snapshot).toEqual({ interval: 900, push: 'no' });
});

test('writeConfig refuses to overwrite a malformed config (never a silent clobber)', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault]\npath = "/keep"\n[serve\nport = ???'); // broken TOML
  let threw = false;
  try {
    writeServePort(file, 50129);
  } catch (error) {
    threw = true;
    expect(error instanceof Error && /not valid TOML/.test(error.message)).toBe(true);
  }
  expect(threw).toBe(true);
  // The broken file is left as-is, not clobbered.
  expect(readFileSync(file, 'utf8')).toContain('/keep');
});

test('writeServePort no longer clobbers: an existing [vault] path survives', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[vault]\npath = "/keep"\n');
  writeServePort(file, 50126);
  expect(readConfig(file)).toEqual({
    serve: { port: 50126 },
    store: {},
    vault: { path: '/keep' },
  });
});
