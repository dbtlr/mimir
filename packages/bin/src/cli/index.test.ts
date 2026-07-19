/**
 * MMR-308 — the CLI transport barrel. `Io` now re-exports from `../presentation`
 * (it used to come from `./render`); `runCli`, `Defaults`, and `findBinding`
 * are unchanged. This pins the barrel's public surface so the re-export
 * plumbing can't silently drift from what `./run` and `./binding` actually
 * export.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Store } from '../core';
import { findBinding, runCli } from './index';
import type { Defaults, Io } from './index';

// Data-free paths (help/usage/unknown command) must never acquire a store —
// proof the barrel's `runCli` is wired to the same guarantee as `./run`.
const neverStore = (): Store => {
  throw new Error('store acquired on a data-free path');
};

function fakeIo(isTTY = false): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    error: (s) => err.push(s),
    isTTY,
    out,
    plain: true,
    write: (s) => out.push(s),
  };
}

test('runCli re-exported from the barrel prints help and exits 0', async () => {
  const io = fakeIo(true);
  expect(await runCli([], neverStore, io)).toBe(0);
  expect(io.out.join('')).toContain('usage: mimir');
});

test('runCli re-exported from the barrel exits 2 on an unknown command', async () => {
  const io = fakeIo(true);
  expect(await runCli(['frobnicate'], neverStore, io)).toBe(2);
  expect(io.err.join('')).toContain('unknown command');
});

test('the Io type re-exported from the barrel matches the presentation shape', () => {
  // Compile-time proof the barrel's `Io` still structurally matches what
  // `write`/`error`/`isTTY`/`plain` implementations (like fakeIo above) provide.
  const io: Io = fakeIo();
  io.write('hello');
  expect(io.out).toEqual(['hello']);
});

test('the Defaults type re-exported from the barrel accepts a partial scope override', () => {
  const defaults: Defaults = { scope: 'MMR' };
  expect(defaults.scope).toBe('MMR');
});

test('findBinding re-exported from the barrel resolves a written binding file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-index-'));
  try {
    expect(findBinding(dir)).toBeUndefined();
    writeFileSync(join(dir, '.mimir.toml'), 'project = "MMR"\n');
    expect(findBinding(dir)).toBe('MMR');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});