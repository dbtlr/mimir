import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectMimirError } from '../core/testing';
import { bunExec } from '../exec';
import { converge } from './converge';
import {
  MARKER_FILE,
  NORN_CONFIG_FILE,
  VAULT_SCHEMA,
  renderMarker,
  renderNornConfig,
} from './schema';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mimir-vault-'));
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const vaultAt = (name: string) => join(root, name);

/** An exec whose spawn itself fails — the missing-git-binary environment. */
const noGitExec = () => Promise.reject(new Error('Executable not found in $PATH: "git"'));

async function gitLog(path: string): Promise<string[]> {
  const r = await bunExec(['git', '-C', path, 'log', '--format=%s']);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

async function gitStatus(path: string): Promise<string> {
  const r = await bunExec(['git', '-C', path, 'status', '--porcelain']);
  return r.stdout.trim();
}

test('create: an absent directory scaffolds marker, rules, and a committed git repo', async () => {
  const path = vaultAt('fresh');
  const result = await converge(path, { allowCreate: true, exec: bunExec });
  expect(result.outcome).toBe('created');

  expect(readFileSync(join(path, MARKER_FILE), 'utf8')).toBe(renderMarker());
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe(renderNornConfig());
  expect(existsSync(join(path, '.git'))).toBe(true);
  expect(await gitLog(path)).toEqual([`mimir: initialize vault (schema ${String(VAULT_SCHEMA)})`]);
  expect(await gitStatus(path)).toBe('');
});

test('create: an empty directory (or .DS_Store-only) is treated as fresh', async () => {
  const empty = vaultAt('empty');
  mkdirSync(empty);
  expect((await converge(empty, { allowCreate: true, exec: bunExec })).outcome).toBe('created');

  const finder = vaultAt('finder');
  mkdirSync(finder);
  writeFileSync(join(finder, '.DS_Store'), '');
  expect((await converge(finder, { allowCreate: true, exec: bunExec })).outcome).toBe('created');
});

test('converge is idempotent: a second run is a no-op with no new commit', async () => {
  const path = vaultAt('twice');
  await converge(path, { allowCreate: true, exec: bunExec });
  const again = await converge(path, { allowCreate: true, exec: bunExec });
  expect(again.outcome).toBe('converged');
  expect(again.outcome === 'converged' && again.upgraded).toBe(false);
  expect(await gitLog(path)).toHaveLength(1);
});

test('mount-safety: an absent or uninitialized path is an error when creation is not allowed', async () => {
  await expectMimirError('not_found', () =>
    converge(vaultAt('missing'), { allowCreate: false, exec: bunExec }),
  );
  const empty = vaultAt('empty-configured');
  mkdirSync(empty);
  await expectMimirError('not_found', () => converge(empty, { allowCreate: false, exec: bunExec }));
});

test('refusal: a non-empty directory without the marker is not adopted', async () => {
  const foreign = vaultAt('foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'notes.md'), '# someone else lives here\n');
  await expectMimirError('conflict', () => converge(foreign, { allowCreate: true, exec: bunExec }));
  // untouched: no marker, no rules, no git
  expect(existsSync(join(foreign, MARKER_FILE))).toBe(false);
  expect(existsSync(join(foreign, '.git'))).toBe(false);
});

test('downgrade guard: a marker schema newer than this binary refuses', async () => {
  const path = vaultAt('future');
  await converge(path, { allowCreate: true, exec: bunExec });
  writeFileSync(join(path, MARKER_FILE), `schema = ${String(VAULT_SCHEMA + 1)}\n`);
  await expectMimirError('conflict', () => converge(path, { allowCreate: false, exec: bunExec }));
});

test('a malformed marker refuses rather than clobbering', async () => {
  const path = vaultAt('mangled');
  await converge(path, { allowCreate: true, exec: bunExec });
  writeFileSync(join(path, MARKER_FILE), 'schema = "not a number"\n');
  await expectMimirError('conflict', () => converge(path, { allowCreate: false, exec: bunExec }));
});

test("upgrade: an older binary's committed state is regenerated, bumped, and committed", async () => {
  const path = vaultAt('stale');
  await converge(path, { allowCreate: true, exec: bunExec });
  // model a vault written by an older binary: its state is committed history
  writeFileSync(join(path, NORN_CONFIG_FILE), '# rules from an older mimir\n');
  writeFileSync(join(path, MARKER_FILE), 'schema = 0\n');
  await bunExec(['git', '-C', path, 'add', '-A']);
  await bunExec([
    'git',
    '-C',
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-m',
    'old binary state',
  ]);

  // A schema upgrade requires a data migrator; this vault has no work-state docs,
  // so a no-op migrator stands in (the backfill itself is covered in backfill.test).
  const result = await converge(path, {
    allowCreate: false,
    exec: bunExec,
    migrateData: () => Promise.resolve([]),
  });
  expect(result.outcome).toBe('converged');
  expect(result.outcome === 'converged' && result.upgraded).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe(renderNornConfig());
  expect(readFileSync(join(path, MARKER_FILE), 'utf8')).toBe(renderMarker());
  expect((await gitLog(path))[0]).toBe(`mimir: converge vault to schema ${String(VAULT_SCHEMA)}`);
  expect(await gitStatus(path)).toBe('');
});

test('upgrade without a data migrator refuses rather than stranding docs (MMR-170)', async () => {
  const path = vaultAt('no-migrator');
  await converge(path, { allowCreate: true, exec: bunExec });
  writeFileSync(join(path, MARKER_FILE), 'schema = 2\n'); // an older-schema vault
  // Omitting migrateData on a version upgrade would bump the marker and leave
  // every pre-existing doc in the old shape with no retry — refuse loudly.
  await expectMimirError('conflict', () => converge(path, { allowCreate: false, exec: bunExec }));
});

test('a failed data migration writes nothing structural, leaving a clean retryable state (MMR-170)', async () => {
  const path = vaultAt('crash');
  await converge(path, { allowCreate: true, exec: bunExec });
  // Commit an older-schema state (distinct rules) so a stray rules rewrite would
  // dirty the tree — the signal this test guards.
  writeFileSync(join(path, NORN_CONFIG_FILE), '# old binary rules\n');
  writeFileSync(join(path, MARKER_FILE), 'schema = 2\n');
  await bunExec(['git', '-C', path, 'add', '-A']);
  await bunExec([
    'git',
    '-C',
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-m',
    'schema 2 state',
  ]);

  let caught: unknown;
  try {
    await converge(path, {
      allowCreate: false,
      exec: bunExec,
      migrateData: () => Promise.reject(new Error('backfill exploded')),
    });
  } catch (error) {
    caught = error;
  }
  expect((caught as Error | undefined)?.message).toBe('backfill exploded');

  // The backfill runs before any structural write, so the throw leaves the marker
  // at the old schema and the rules untouched — the next converge retries cleanly,
  // never a committed schema-3 marker beside stale schema-2 rules.
  expect(readFileSync(join(path, MARKER_FILE), 'utf8')).toBe('schema = 2\n');
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe('# old binary rules\n');
  expect(await gitStatus(path)).toBe('');
});

test('uncommitted drift converges back to committed content without a commit', async () => {
  const path = vaultAt('roundtrip');
  await converge(path, { allowCreate: true, exec: bunExec });
  writeFileSync(join(path, NORN_CONFIG_FILE), '# uncommitted drift\n');

  const result = await converge(path, { allowCreate: false, exec: bunExec });
  expect(result.outcome === 'converged' && result.upgraded).toBe(true); // the file was rewritten
  expect(result.warnings).toEqual([]); // nothing-to-commit is a no-op, not a failure
  expect(await gitLog(path)).toHaveLength(1); // no second commit
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe(renderNornConfig());
});

test('upgrade commits only converge-owned files, never operator changes', async () => {
  const path = vaultAt('dirty');
  await converge(path, { allowCreate: true, exec: bunExec });
  writeFileSync(join(path, 'WIP.md'), 'operator scratch\n');
  writeFileSync(join(path, NORN_CONFIG_FILE), '# drift\n');

  await converge(path, { allowCreate: false, exec: bunExec });
  // the operator file is still uncommitted
  expect(await gitStatus(path)).toContain('WIP.md');
});

test('adopt: a cloned/restored vault missing .git is re-initialized', async () => {
  const path = vaultAt('restored');
  mkdirSync(join(path, '.norn'), { recursive: true });
  writeFileSync(join(path, MARKER_FILE), renderMarker());
  writeFileSync(join(path, NORN_CONFIG_FILE), renderNornConfig());

  const result = await converge(path, { allowCreate: false, exec: bunExec });
  expect(result.outcome).toBe('converged');
  expect(existsSync(join(path, '.git'))).toBe(true);
});

test('a regular file at the vault path refuses with a hint, not a raw ENOTDIR', async () => {
  const path = vaultAt('a-file');
  writeFileSync(path, 'not a directory\n');
  await expectMimirError('conflict', () => converge(path, { allowCreate: true, exec: bunExec }));
});

test('a dangling symlink reads as an unmounted volume, not as absent', async () => {
  const path = vaultAt('link');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(vaultAt('missing-target'), path);
  // even with allowCreate, never scaffold through a dangling link
  await expectMimirError('not_found', () => converge(path, { allowCreate: true, exec: bunExec }));
});

test('self-heal: a crash-window scaffold (marker only) converges instead of refusing', async () => {
  const path = vaultAt('partial');
  mkdirSync(path);
  writeFileSync(join(path, MARKER_FILE), renderMarker()); // create() writes this first
  const result = await converge(path, { allowCreate: false, exec: bunExec });
  expect(result.outcome).toBe('converged');
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe(renderNornConfig());
});

test('a missing git binary degrades to warnings, never an error', async () => {
  const path = vaultAt('no-git');
  const result = await converge(path, { allowCreate: true, exec: noGitExec });
  expect(result.outcome).toBe('created');
  expect(result.warnings.length).toBeGreaterThan(0);
  // the scaffold itself still landed
  expect(readFileSync(join(path, MARKER_FILE), 'utf8')).toBe(renderMarker());
});

test('converge commits are immune to global gpgsign/hooks git config', async () => {
  const path = vaultAt('gpg');
  const seen: string[][] = [];
  const spy = (argv: string[]) => {
    seen.push(argv);
    return bunExec(argv);
  };
  await converge(path, { allowCreate: true, exec: spy });
  for (const argv of seen) {
    expect(argv.join(' ')).toContain('commit.gpgsign=false');
    expect(argv.join(' ')).toContain('core.hooksPath=/dev/null');
  }
});
