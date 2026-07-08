import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveInstallEnv } from './serve-env';

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'mimir-serve-env-'));
});
afterEach(() => {
  rmSync(vault, { force: true, recursive: true });
});

test('SQLite backend carries only MIMIR_DB and never touches norn/vault', () => {
  const env = serveInstallEnv({
    backend: 'sqlite',
    dbPath: '/data/mimir.db',
    // even an absent norn / missing vault is irrelevant on SQLite
    nornPath: undefined,
    vault: '/nonexistent/vault',
  });
  expect(env).toEqual({ dbPath: '/data/mimir.db' });
});

test('Norn backend bakes the resolved norn + vault absolutes', () => {
  const env = serveInstallEnv({
    backend: 'norn',
    nornPath: '/Users/op/.cargo/bin/norn',
    vault,
  });
  expect(env).toEqual({ nornPath: '/Users/op/.cargo/bin/norn', vaultPath: vault });
});

test('Norn install fails loudly when norn is not on PATH', () => {
  expect(() => serveInstallEnv({ backend: 'norn', nornPath: undefined, vault })).toThrow(/norn/);
});

test('Norn install fails loudly when the configured vault does not exist', () => {
  expect(() =>
    serveInstallEnv({
      backend: 'norn',
      nornPath: '/Users/op/.cargo/bin/norn',
      vault: join(vault, 'does-not-exist'),
    }),
  ).toThrow(/vault does not exist/);
});
