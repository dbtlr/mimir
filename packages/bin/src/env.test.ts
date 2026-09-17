import { expect, test } from 'bun:test';

import { DEFAULT_PORT, DEV_PORT, IS_PRODUCTION, defaultVaultPath, envPort } from './env';

test('source runs do not gain live installation authority', () => {
  expect(IS_PRODUCTION).toBe(false);
});

test('the default port is the dev port, off the production port', () => {
  expect(DEFAULT_PORT).toBe(DEV_PORT);
  expect(DEFAULT_PORT).not.toBe(64647);
});

test('the dev vault is an isolated repo-local .dev vault, never the production path', () => {
  const path = defaultVaultPath();
  expect(path).toEndWith('/.dev/vault');
  expect(path).not.toContain('/.local/share/mimir');
});

test('envPort parses a valid port, rejects malformed, and passes through unset', () => {
  expect(envPort('64747')).toBe(64747);
  expect(envPort('1')).toBe(1);
  expect(envPort('65535')).toBe(65535);
  expect(envPort(undefined)).toBeUndefined();
  // Out of range / non-integer → null (caller warns and falls through).
  expect(envPort('0')).toBeNull();
  expect(envPort('70000')).toBeNull();
  expect(envPort('nope')).toBeNull();
  expect(envPort('64.5')).toBeNull();
});
