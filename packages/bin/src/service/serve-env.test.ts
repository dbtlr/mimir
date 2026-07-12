import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedVault } from '../vault/resolve';
import { serveInstallEnv } from './serve-env';

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'mimir-serve-env-'));
});
afterEach(() => {
  rmSync(vault, { force: true, recursive: true });
});

/** An explicit (env/config) vault: must pre-exist, and is baked. */
const explicit = (path: string): ResolvedVault => ({ allowCreate: false, path, source: 'config' });
/** The derived default: auto-creatable at boot, so never required and never baked. */
const derivedDefault = (path: string): ResolvedVault => ({
  allowCreate: true,
  path,
  source: 'default',
});

test('bakes the resolved norn + an explicit existing vault', () => {
  const env = serveInstallEnv({
    nornPath: '/Users/op/.cargo/bin/norn',
    vault: explicit(vault),
  });
  expect(env).toEqual({ nornPath: '/Users/op/.cargo/bin/norn', vaultPath: vault });
});

test('install fails loudly when norn is not on PATH', () => {
  expect(() => serveInstallEnv({ nornPath: undefined, vault: explicit(vault) })).toThrow(/norn/);
});

test('install fails loudly when an explicit vault does not exist', () => {
  expect(() =>
    serveInstallEnv({
      nornPath: '/Users/op/.cargo/bin/norn',
      vault: explicit(join(vault, 'does-not-exist')),
    }),
  ).toThrow(/vault does not exist/);
});

test('leaves the auto-creatable default unbaked (daemon converge creates it)', () => {
  // A first-boot install: the default vault may not exist yet, and baking
  // MIMIR_VAULT would flip resolveVault's allowCreate off at the daemon and
  // disable the boot-time create. So bake norn only, and do NOT require the path.
  const env = serveInstallEnv({
    nornPath: '/Users/op/.cargo/bin/norn',
    vault: derivedDefault(join(vault, 'not-created-yet')),
  });
  expect(env).toEqual({ nornPath: '/Users/op/.cargo/bin/norn' });
});
