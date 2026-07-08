import { expect, test } from 'bun:test';

import {
  DEFAULT_PORT,
  DEV_PORT,
  IS_PRODUCTION,
  defaultStorePath,
  envFlag,
  envPort,
  storePath,
} from './env';

// Unit/dev runs are not compiled with `--define MIMIR_BUILD_PROFILE`, so the
// build profile is dev — the same reasoning as version.test.ts (MMR-117/MMR-57).

test('dev/from-source is not the production profile', () => {
  expect(IS_PRODUCTION).toBe(false);
});

test('the default port is the dev port, off the production port', () => {
  expect(DEFAULT_PORT).toBe(DEV_PORT);
  expect(DEFAULT_PORT).not.toBe(64647);
});

test('the dev store is an isolated repo-local .dev store, never the production path', () => {
  const path = defaultStorePath();
  expect(path).toEndWith('/.dev/mimir.db');
  expect(path).not.toContain('/.local/share/mimir');
});

test('storePath honors MIMIR_DB as the explicit override', () => {
  const original = process.env.MIMIR_DB;
  try {
    process.env.MIMIR_DB = '/tmp/explicit-store.db';
    expect(storePath()).toBe('/tmp/explicit-store.db');
  } finally {
    if (original === undefined) {
      delete process.env.MIMIR_DB;
    } else {
      process.env.MIMIR_DB = original;
    }
  }
});

test('storePath falls back to the dev default when MIMIR_DB is unset', () => {
  const original = process.env.MIMIR_DB;
  try {
    delete process.env.MIMIR_DB;
    expect(storePath()).toBe(defaultStorePath());
  } finally {
    if (original !== undefined) {
      process.env.MIMIR_DB = original;
    }
  }
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

// MMR-147 review finding: presence-based parsing read =0/=false as opt-IN —
// the exact inversion a safety flag must never have. envFlag is value-based.
test('envFlag enables only on an explicit affirmative', () => {
  expect(envFlag('1')).toBe(true);
  expect(envFlag('true')).toBe(true);
  expect(envFlag('TRUE')).toBe(true);
  expect(envFlag('yes')).toBe(true);
  expect(envFlag('on')).toBe(true);
  // Falsy intents and noise stay DISABLED — never an accidental opt-in.
  expect(envFlag('0')).toBe(false);
  expect(envFlag('false')).toBe(false);
  expect(envFlag('no')).toBe(false);
  expect(envFlag('off')).toBe(false);
  expect(envFlag('')).toBe(false);
  expect(envFlag(' ')).toBe(false);
  expect(envFlag('maybe')).toBe(false);
  expect(envFlag(undefined)).toBe(false);
});
