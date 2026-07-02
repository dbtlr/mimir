import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveVault } from './resolve';

test('precedence: env wins over config, config over the built-in default', () => {
  expect(resolveVault({ configPath: '/cfg/vault', envPath: '/env/vault' })).toEqual({
    allowCreate: false,
    path: '/env/vault',
    source: 'env',
  });
  expect(resolveVault({ configPath: '/cfg/vault' })).toEqual({
    allowCreate: false,
    path: '/cfg/vault',
    source: 'config',
  });
  const fallback = resolveVault({});
  expect(fallback.source).toBe('default');
  expect(fallback.path.endsWith(join('.dev', 'vault'))).toBe(true); // from-source = dev profile
});

test('a leading ~/ expands against the home directory (env and config alike)', () => {
  expect(resolveVault({ envPath: '~/vaults/mimir' }).path).toBe(join(homedir(), 'vaults', 'mimir'));
  expect(resolveVault({ configPath: '~/vaults/mimir' }).path).toBe(
    join(homedir(), 'vaults', 'mimir'),
  );
});

test('only the derived default is eligible for auto-create', () => {
  expect(resolveVault({}).allowCreate).toBe(true);
  expect(resolveVault({ envPath: '/env/vault' }).allowCreate).toBe(false);
  expect(resolveVault({ configPath: '/cfg/vault' }).allowCreate).toBe(false);
});

test('a bare ~ expands to the home directory', () => {
  expect(resolveVault({ envPath: '~' }).path).toBe(homedir());
});
