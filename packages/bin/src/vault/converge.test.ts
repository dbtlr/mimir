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

  const result = await converge(path, { allowCreate: false, exec: bunExec });
  expect(result.outcome).toBe('converged');
  expect(result.outcome === 'converged' && result.upgraded).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(readFileSync(join(path, NORN_CONFIG_FILE), 'utf8')).toBe(renderNornConfig());
  expect(readFileSync(join(path, MARKER_FILE), 'utf8')).toBe(renderMarker());
  expect((await gitLog(path))[0]).toBe(`mimir: converge vault to schema ${String(VAULT_SCHEMA)}`);
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
