import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject } from './create';
import { SCHEMA_VERSION } from './store-sql/migrator';
import { sqliteStoreHoldsProjects } from './store-sqlite-backend';
import { createSqliteStore, openSqlite, SQLITE_FILE } from './store-sqlite/index';

/**
 * Whether an installation's SQLite store holds a project (MMR-592): asked of
 * the file as it lies, so the question never creates or migrates anything.
 */
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-backend-'));
  path = join(dir, 'data', SQLITE_FILE);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** Create the store file with `keys` as projects, the first `archived` when asked. */
async function seedStore(keys: string[], archived = false): Promise<void> {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const handle = await openSqlite(path);
  try {
    const store = createSqliteStore(handle.db);
    for (const key of keys) {
      await createProject(store, { description: null, key, name: key });
    }
    if (archived) {
      await handle.db
        .updateTable('project')
        .set({ archived_at: '2026-01-01T00:00:00.000Z' })
        .execute();
    }
  } finally {
    await handle.close();
  }
}

test('an absent store file holds no project, and the check creates nothing', async () => {
  expect(await sqliteStoreHoldsProjects(path)).toBe(false);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(dir, 'data'))).toBe(false);
});

test('a zero-length store file holds no project', async () => {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(path, '');
  expect(await sqliteStoreHoldsProjects(path)).toBe(false);
});

test('a migrated store with no project holds none', async () => {
  await seedStore([]);
  expect(await sqliteStoreHoldsProjects(path)).toBe(false);
});

test('a store with an active project holds one', async () => {
  await seedStore(['MMR']);
  expect(await sqliteStoreHoldsProjects(path)).toBe(true);
});

test('a store whose only project is archived still holds one', async () => {
  await seedStore(['MMR'], true);
  expect(await sqliteStoreHoldsProjects(path)).toBe(true);
});

test('the check migrates nothing: a store at an older schema is refused and left as found', async () => {
  await seedStore(['MMR']);
  const handle = await openSqlite(path);
  await handle.db.deleteFrom('schema_version').where('version', '=', SCHEMA_VERSION).execute();
  await handle.close();
  const before = readFileSync(path);

  let message = '';
  try {
    await sqliteStoreHoldsProjects(path);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('the SQLite store schema is version');
  expect(readFileSync(path).equals(before)).toBe(true);
});
