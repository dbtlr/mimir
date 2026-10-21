import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MimirError } from './errors';
import { assertWritable } from './writable';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-writable-'));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { force: true, recursive: true });
});

// As root every path is writable, so the refusal cases prove nothing there.
const asRoot = process.getuid?.() === 0;

function refusalOf(attempt: () => unknown): MimirError {
  try {
    attempt();
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    return error as MimirError;
  }
  throw new Error('expected a refusal');
}

test('a file in a writable directory, existing or not, and a directory still to be created, pass', () => {
  assertWritable(join(dir, 'new.toml'));
  writeFileSync(join(dir, 'old.toml'), '');
  assertWritable(join(dir, 'old.toml'));
  assertWritable(join(dir, 'a', 'b', 'c.toml'));
});

test.skipIf(asRoot)('a read-only file is refused with the path and a chmod remedy', () => {
  const file = join(dir, 'config.toml');
  writeFileSync(file, '');
  chmodSync(file, 0o444);
  const error = refusalOf(() => assertWritable(file));
  expect(error.message).toContain(file);
  expect(error.hint).toContain(`chmod u+w ${file}`);
});

test.skipIf(asRoot)('a read-only directory, or the ancestor of one to create, is refused', () => {
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  expect(refusalOf(() => assertWritable(join(locked, 'x.toml'))).message).toContain(locked);
  expect(refusalOf(() => assertWritable(join(locked, 'deep', 'x.toml'))).message).toContain(locked);
  chmodSync(locked, 0o755);
});
