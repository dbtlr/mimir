import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath, readConfig, readServeConfig, readVaultConfig, writeServePort } from './config';

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
