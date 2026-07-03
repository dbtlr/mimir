import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Exec, ExecResult } from '../exec';
import { snapshotVault } from './snapshot';

type Resp = { code?: number; stdout?: string; stderr?: string };

/**
 * A fake `git` over the pinned-identity argv. Sensible defaults describe a
 * healthy, purely-local repo (inside a work tree, on `main`, clean, no
 * upstream); each test overrides only the commands it cares about. An array
 * value is a per-call sequence (last entry repeats), for reject-then-recover.
 */
function fakeGit(overrides: Record<string, Resp | Resp[]> = {}): {
  exec: Exec;
  calls: string[][];
} {
  const defaults: Record<string, Resp> = {
    'add -A': { code: 0 },
    'branch --show-current': { code: 0, stdout: 'main\n' },
    commit: { code: 0 },
    'diff --cached --quiet': { code: 0 },
    fetch: { code: 0 },
    merge: { code: 0 },
    push: { code: 0 },
    'remote add': { code: 0 },
    'remote get-url origin': { code: 128, stderr: 'no origin' },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 128, stderr: 'no upstream' },
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
  };
  const table = { ...defaults, ...overrides };
  const keys = Object.keys(table).toSorted((a, b) => b.length - a.length);
  const counters: Record<string, number> = {};
  const calls: string[][] = [];
  const exec: Exec = async (argv): Promise<ExecResult> => {
    const idx = argv.indexOf('core.hooksPath=/dev/null');
    const args = idx === -1 ? argv.slice(1) : argv.slice(idx + 1);
    calls.push(args);
    const line = args.join(' ');
    const key = keys.find((k) => line.startsWith(k));
    const spec = key === undefined ? {} : table[key];
    let resp: Resp = {};
    if (Array.isArray(spec)) {
      const n = counters[key ?? ''] ?? 0;
      resp = spec[Math.min(n, spec.length - 1)] ?? {};
      counters[key ?? ''] = n + 1;
    } else if (spec !== undefined) {
      resp = spec;
    }
    return { code: resp.code ?? 0, stderr: resp.stderr ?? '', stdout: resp.stdout ?? '' };
  };
  return { calls, exec };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-snapshot-'));
  mkdirSync(join(dir, '.git'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const STAMP = '2026-07-03T04:00';

test('clean tree is a silent no-op', async () => {
  const { exec, calls } = fakeGit();
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ committed: false, outcome: 'clean', pushed: false });
  expect(r.alerts).toEqual([]);
  // Never reached the commit — diff came back clean.
  expect(calls.some((c) => c[0] === 'commit')).toBe(false);
});

test('dirty tree with no remote commits locally', async () => {
  const { exec, calls } = fakeGit({ 'diff --cached --quiet': { code: 1 } });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ committed: true, outcome: 'committed', pushed: false });
  expect(r.alerts).toEqual([]);
  const commit = calls.find((c) => c[0] === 'commit');
  expect(commit).toEqual(['commit', '-m', `auto snapshot: ${STAMP}`]);
});

test('dirty tree with an upstream commits and pushes', async () => {
  const { exec } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ committed: true, outcome: 'pushed', pushed: true });
  expect(r.alerts).toEqual([]);
});

test('push=false keeps the snapshot purely local even with an upstream', async () => {
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, push: false, stamp: STAMP });
  expect(r).toMatchObject({ committed: true, outcome: 'committed', pushed: false });
  expect(calls.some((c) => c[0] === 'push')).toBe(false);
});

test('no upstream but an origin establishes it with push -u', async () => {
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    'remote get-url origin': { code: 0, stdout: 'git@example.com:me/v.git\n' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ outcome: 'pushed', pushed: true });
  expect(calls).toContainEqual(['push', '-u', 'origin', 'main']);
});

test('no upstream, no origin, config upstream is adopted as origin then pushed', async () => {
  const { exec, calls } = fakeGit({ 'diff --cached --quiet': { code: 1 } });
  const r = await snapshotVault({
    exec,
    path: dir,
    stamp: STAMP,
    upstream: 'git@example.com:me/v.git',
  });
  expect(r).toMatchObject({ outcome: 'pushed', pushed: true });
  expect(calls).toContainEqual(['remote', 'add', 'origin', 'git@example.com:me/v.git']);
  expect(calls).toContainEqual(['push', '-u', 'origin', 'main']);
});

test('a rejected push reconciles via fetch + merge, then pushes', async () => {
  // push: reject, reject (post-fetch), succeed (post-merge)
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    push: [{ code: 1, stderr: 'rejected' }, { code: 1, stderr: 'rejected' }, { code: 0 }],
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ committed: true, outcome: 'reconciled', pushed: true });
  expect(r.alerts).toEqual([]);
  expect(calls).toContainEqual(['fetch', '--prune']);
  expect(calls.some((c) => c[0] === 'merge' && c[1] === '--no-edit')).toBe(true);
});

test('a rejected push that clears after fetch alone does not merge', async () => {
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    push: [{ code: 1, stderr: 'rejected' }, { code: 0 }],
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r).toMatchObject({ outcome: 'reconciled', pushed: true });
  expect(calls.some((c) => c[0] === 'merge')).toBe(false);
});

test('a merge conflict aborts and alerts, leaving a clean tree', async () => {
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    merge: { code: 1, stderr: 'CONFLICT' },
    push: { code: 1, stderr: 'rejected' },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.pushed).toBe(false);
  expect(r.committed).toBe(true);
  expect(r.alerts[0]).toContain('merge conflict');
  expect(calls).toContainEqual(['merge', '--abort']);
});

test('push rejected with reconcile disabled is a loud alert', async () => {
  const { exec, calls } = fakeGit({
    'diff --cached --quiet': { code: 1 },
    push: { code: 1, stderr: 'rejected' },
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n' },
  });
  const r = await snapshotVault({ exec, path: dir, pull: false, stamp: STAMP });
  expect(r.pushed).toBe(false);
  expect(r.alerts[0]).toContain('reconcile is disabled');
  expect(calls.some((c) => c[0] === 'fetch')).toBe(false);
});

test('detached HEAD refuses to snapshot', async () => {
  const { exec, calls } = fakeGit({ 'branch --show-current': { code: 0, stdout: '\n' } });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.alerts[0]).toContain('detached HEAD');
  expect(calls.some((c) => c[0] === 'add')).toBe(false);
});

test('an in-progress merge refuses to commit over it', async () => {
  writeFileSync(join(dir, '.git', 'MERGE_HEAD'), 'deadbeef\n');
  const { exec, calls } = fakeGit({ 'diff --cached --quiet': { code: 1 } });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.alerts[0]).toContain('in-progress');
  expect(calls.some((c) => c[0] === 'add')).toBe(false);
});

test('a non-git directory alerts', async () => {
  const { exec } = fakeGit({ 'rev-parse --is-inside-work-tree': { code: 128, stderr: 'nope' } });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.alerts[0]).toContain('not a git repository');
});

test('an absent vault path alerts (missing volume), never scaffolds', async () => {
  // The bounded `rev-parse` is the preflight (not a bare existsSync); on a truly
  // absent path git exits nonzero, and existsSync then distinguishes not-found.
  const { exec, calls } = fakeGit({ 'rev-parse --is-inside-work-tree': { code: 128 } });
  const missing = join(dir, 'does-not-exist');
  const r = await snapshotVault({ exec, path: missing, stamp: STAMP });
  expect(r.alerts[0]).toContain('vault not found');
  // Only the bounded inspection ran — nothing that mutates the (absent) vault.
  expect(calls.some((c) => c[0] === 'add' || c[0] === 'commit')).toBe(false);
});

test('a hung inspection (timeout) alerts about a possibly-hanging volume', async () => {
  const { exec } = fakeGit({ 'rev-parse --is-inside-work-tree': { code: 124 } });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.alerts[0]).toContain('hanging');
});

test('a nonzero `git branch --show-current` is a git error, not detached HEAD', async () => {
  // git < 2.22, or a corrupt/locked repo: nonzero exit with empty stdout. This
  // must not be misreported as detached HEAD (finding 4).
  const { exec, calls } = fakeGit({
    'branch --show-current': { code: 129, stderr: 'unknown option --show-current' },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.alerts[0]).toContain('could not read the branch');
  expect(r.alerts[0]).not.toContain('detached');
  expect(calls.some((c) => c[0] === 'add')).toBe(false);
});

test('a failed commit is a loud alert', async () => {
  const { exec } = fakeGit({
    commit: { code: 1, stderr: 'nothing configured' },
    'diff --cached --quiet': { code: 1 },
  });
  const r = await snapshotVault({ exec, path: dir, stamp: STAMP });
  expect(r.committed).toBe(false);
  expect(r.alerts[0]).toContain('commit failed');
});
