import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialsPath, readCredentials, writeCredentials } from './credentials';
import type { Credentials } from './credentials';
import { MimirError } from './errors';

/**
 * A remote CLI's device credentials (ADR 0038): `credentials.toml` beside
 * `config.toml`, written atomically at 0600 and read only when private and
 * recorded for the host the config names.
 */
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-credentials-'));
  file = join(dir, 'credentials.toml');
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const ORIGIN = 'https://mimir.example.test';
const paired: Credentials = {
  device: 'valhalla',
  issuedAt: '2026-10-20T12:00:00.000Z',
  origin: ORIGIN,
  token: 'mimir_tok_abcDEF123-_',
};

/** The refusal `attempt` throws; fails the test when it returns. */
function refusalOf(attempt: () => unknown): MimirError {
  try {
    attempt();
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    return error as MimirError;
  }
  throw new Error('expected a refusal');
}

test('credentials live beside config.toml', () => {
  expect(credentialsPath()).toEndWith('/mimir/credentials.toml');
});

test('written credentials read back for their origin', () => {
  writeCredentials(paired, file);
  expect(readCredentials(ORIGIN, file)).toEqual(paired);
});

test('the file is created at 0600 whatever the umask allows', () => {
  const previous = process.umask(0o000);
  try {
    writeCredentials(paired, file);
  } finally {
    process.umask(previous);
  }
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('writing again replaces the file atomically and leaves no temporary file', () => {
  writeFileSync(file, 'origin = "https://old.example.test"\n', { mode: 0o644 });
  writeCredentials({ ...paired, device: 'rotated' }, file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readCredentials(ORIGIN, file).device).toBe('rotated');
  expect(readdirSync(dir)).toEqual(['credentials.toml']);
});

test('a device name with quotes, backslashes, and newlines round-trips', () => {
  const device = 'drew\'s "box" \\ two\nlines é \u{1F984}';
  writeCredentials({ ...paired, device }, file);
  expect(readCredentials(ORIGIN, file).device).toBe(device);
});

test('missing credentials are refused with the pair remedy', () => {
  const refusal = refusalOf(() => readCredentials(ORIGIN, file));
  expect(refusal.message).toContain(file);
  expect(refusal.hint).toBe(`mimir pair ${ORIGIN}`);
});

test('a file that group or others can access is refused with chmod 600', () => {
  writeCredentials(paired, file);
  for (const mode of [0o640, 0o604, 0o620, 0o602]) {
    chmodSync(file, mode);
    const refusal = refusalOf(() => readCredentials(ORIGIN, file));
    expect(refusal.message).toContain(file);
    expect(refusal.message).toContain(`0${mode.toString(8)}`);
    expect(refusal.hint).toBe(`chmod 600 ${file}`);
  }
});

test('an unreadable or incomplete file is refused with the pair remedy, token unechoed', () => {
  for (const text of [
    'not = = toml',
    'origin = "https://mimir.example.test"\ndevice = "valhalla"\n',
    'origin = "https://mimir.example.test"\ndevice = "valhalla"\ntoken = 7\nissued_at = "x"\n',
  ]) {
    writeFileSync(file, text, { mode: 0o600 });
    const refusal = refusalOf(() => readCredentials(ORIGIN, file));
    expect(refusal.message).toContain(file);
    expect(refusal.hint).toBe(`mimir pair ${ORIGIN}`);
  }
});

test('credentials recorded for another origin are refused before any request', () => {
  writeCredentials({ ...paired, origin: 'https://other.example.test' }, file);
  const refusal = refusalOf(() => readCredentials(ORIGIN, file));
  expect(refusal.message).toContain('https://other.example.test');
  expect(refusal.message).toContain(ORIGIN);
  expect(refusal.message).not.toContain(paired.token);
  expect(refusal.hint).toBe(`mimir pair ${ORIGIN}`);
});
