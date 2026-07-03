import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeIo } from '../cli/testing';
import type { Exec, ExecResult } from '../exec';
import type { SnapshotConfig } from '../service/config';
import type { VaultDeps } from './commands';
import { cmdVault } from './commands';

type Resp = { code?: number; stdout?: string; stderr?: string };

function fakeGit(overrides: Record<string, Resp> = {}): { exec: Exec; calls: string[][] } {
  const table: Record<string, Resp> = {
    'branch --show-current': { code: 0, stdout: 'main\n' },
    'diff --cached --quiet': { code: 0 },
    'remote get-url origin': { code: 128 },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 128 },
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    ...overrides,
  };
  const keys = Object.keys(table).toSorted((a, b) => b.length - a.length);
  const calls: string[][] = [];
  const exec: Exec = async (argv): Promise<ExecResult> => {
    const idx = argv.indexOf('core.hooksPath=/dev/null');
    const args = idx === -1 ? argv.slice(1) : argv.slice(idx + 1);
    calls.push(args);
    const key = keys.find((k) => args.join(' ').startsWith(k));
    const r = key === undefined ? {} : table[key];
    return { code: r?.code ?? 0, stderr: r?.stderr ?? '', stdout: r?.stdout ?? '' };
  };
  return { calls, exec };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-vaultcmd-'));
  mkdirSync(join(dir, '.git'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function deps(exec: Exec, snapshot: SnapshotConfig = {}): VaultDeps {
  return {
    exec,
    resolveVault: () => ({ allowCreate: false, path: dir, source: 'config' }),
    snapshotConfig: () => snapshot,
    stamp: () => '2026-07-03T04:00',
  };
}

test('vault snapshot on a clean tree exits 0 with a quiet success line', async () => {
  const io = fakeIo();
  const { exec } = fakeGit();
  const code = await cmdVault(['vault', 'snapshot'], io, deps(exec), 'records');
  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('nothing to commit');
  expect(io.err).toEqual([]);
});

test('vault snapshot reports a committed snapshot on stdout', async () => {
  const io = fakeIo();
  const { exec } = fakeGit({ 'diff --cached --quiet': { code: 1 } });
  const code = await cmdVault(['vault', 'snapshot'], io, deps(exec), 'records');
  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('committed');
});

test('an alert goes to stderr and exits nonzero, with no success line', async () => {
  const io = fakeIo();
  const { exec } = fakeGit({ 'rev-parse --is-inside-work-tree': { code: 128 } });
  const code = await cmdVault(['vault', 'snapshot'], io, deps(exec), 'records');
  expect(code).toBe(1);
  expect(io.err.join('\n')).toContain('not a git repository');
  expect(io.out).toEqual([]);
});

test('json format emits the structured result', async () => {
  const io = fakeIo();
  const { exec } = fakeGit({ 'diff --cached --quiet': { code: 1 } });
  const code = await cmdVault(['vault', 'snapshot'], io, deps(exec), 'json');
  expect(code).toBe(0);
  const parsed = JSON.parse(io.out.join('')) as { outcome: string; committed: boolean };
  expect(parsed).toMatchObject({ committed: true, outcome: 'committed' });
});

test('config toggles reach the core: push=false stays local', async () => {
  const io = fakeIo();
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const code = await cmdVault(['vault', 'snapshot'], io, deps(exec, { push: false }), 'records');
  expect(code).toBe(0);
  expect(calls.some((c) => c[0] === 'push')).toBe(false);
});

test('an unknown subcommand is a usage error', async () => {
  const io = fakeIo();
  const { exec } = fakeGit();
  // try/catch avoids the await-thenable lint on .rejects.toThrow
  let message = '';
  try {
    await cmdVault(['vault', 'wat'], io, deps(exec), 'records');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/subcommand/);
});
