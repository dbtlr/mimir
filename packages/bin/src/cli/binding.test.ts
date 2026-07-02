import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { BINDING_FILE, findBinding, parseBinding, writeBinding } from './binding';
import { runCli } from './run';
import { fakeIo } from './testing';

// ---------------------------------------------------------------------------
// The binding file itself
// ---------------------------------------------------------------------------

test('parseBinding extracts the key, tolerating whitespace and comments', () => {
  expect(parseBinding('project = "MMR"\n')).toBe('MMR');
  expect(parseBinding('  project="AB"  # the work project\n')).toBe('AB');
  expect(parseBinding('# nothing here\nother = "x"\n')).toBeUndefined();
  expect(parseBinding('project = "lowercase"\n')).toBeUndefined();
  expect(parseBinding('project = "TOOLONGKEY"\n')).toBeUndefined();
});

test('findBinding walks up and the nearest file wins; malformed nearest stops the walk', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-bind-'));
  try {
    const mid = join(root, 'repo');
    const leaf = join(mid, 'packages', 'web');
    mkdirSync(leaf, { recursive: true });

    expect(findBinding(leaf)).toBeUndefined();

    writeFileSync(join(root, BINDING_FILE), 'project = "OUT"\n');
    expect(findBinding(leaf)).toBe('OUT');

    writeFileSync(join(mid, BINDING_FILE), 'project = "MID"\n');
    expect(findBinding(leaf)).toBe('MID');

    // A malformed nearest binding must not fall through to OUT/MID —
    // silently scoping to a different project's board would be worse.
    writeFileSync(join(leaf, BINDING_FILE), 'project = broken\n');
    expect(findBinding(leaf)).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('writeBinding round-trips through findBinding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-bind-'));
  try {
    const file = writeBinding(dir, 'MMR');
    expect(readFileSync(file, 'utf8')).toBe('project = "MMR"\n');
    expect(findBinding(dir)).toBe('MMR');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The bind verb + default scope through the CLI
// ---------------------------------------------------------------------------

let db: Db;
let store: Store;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  for (const key of ['MMR', 'XX'] as const) {
    const p = await createProject(store, { key, name: key.toLowerCase() });
    const init = await createInitiative(store, { projectId: p.id, title: 'i' });
    const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
    await createTask(store, { parentId: phase.id, title: `${key} work` });
  }
});
afterEach(async () => {
  await db.destroy();
});

test('bind writes .mimir.toml into the injected cwd and echoes the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-bind-'));
  try {
    const io = fakeIo();
    expect(await runCli(['bind', 'MMR', '-f', 'ids'], () => store, io, { cwd: dir })).toBe(0);
    expect(io.out.join('')).toBe('MMR');
    expect(findBinding(dir)).toBe('MMR');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('bind validates the project exists (not_found, exit 1) and requires a key (exit 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-bind-'));
  try {
    const io = fakeIo();
    expect(await runCli(['bind', 'NOPE'], () => store, io, { cwd: dir })).toBe(1);
    expect(findBinding(dir)).toBeUndefined();
    expect(await runCli(['bind'], () => store, fakeIo(), { cwd: dir })).toBe(2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('the bound scope is the default for next/list; explicit -s wins; -s all escapes', async () => {
  const bound = async (argv: string[]): Promise<string[]> => {
    const io = fakeIo();
    expect(await runCli(argv, () => store, io, { scope: 'MMR' })).toBe(0);
    return io.out.join('\n').split('\n').filter(Boolean);
  };

  const defaulted = await bound(['next', '-f', 'ids']);
  expect(defaulted).toEqual(['MMR-3']);

  const explicit = await bound(['next', '-s', 'XX', '-f', 'ids']);
  expect(explicit).toEqual(['XX-3']);

  const all = await bound(['next', '-s', 'all', '-f', 'ids']);
  expect(all.toSorted()).toEqual(['MMR-3', 'XX-3']);

  const listAll = await bound(['list', '-s', 'all', '-f', 'ids']);
  expect(listAll.toSorted()).toEqual(['MMR-3', 'XX-3']); // both projects' tasks
});

// ---------------------------------------------------------------------------
// The create-project confirmation gate (-y/--yes)
// ---------------------------------------------------------------------------

test('create project without --yes fails non-interactively (usage, exit 2)', async () => {
  const io = fakeIo(); // isTTY: false
  expect(await runCli(['create', 'project', 'New', '--key', 'NEW'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('immutable');
  expect(io.err.join('')).toContain('--yes');
});

test('create project --yes succeeds non-interactively', async () => {
  const io = fakeIo();
  expect(
    await runCli(['create', 'project', 'New', '--key', 'NEW', '-y', '-f', 'ids'], () => store, io),
  ).toBe(0);
  expect(io.out.join('')).toBe('NEW');
});

test('create project at a TTY prompts; declining aborts with exit 1', async () => {
  const realConfirm = globalThis.confirm;
  try {
    globalThis.confirm = () => true;
    const io = fakeIo(true);
    expect(
      await runCli(['create', 'project', 'Yep', '--key', 'YEP', '-f', 'ids'], () => store, io),
    ).toBe(0);

    globalThis.confirm = () => false;
    const no = fakeIo(true);
    expect(await runCli(['create', 'project', 'Nope', '--key', 'NOPE'], () => store, no)).toBe(1);
    expect(no.err.join('')).toContain('aborted');
  } finally {
    globalThis.confirm = realConfirm;
  }
});
