import { expect, test } from 'bun:test';

import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { readSchemaVersion, SCHEMA_VERSION } from './index';
import type { DB } from './index';
import { createEmptyPglite, createPgliteTestStore } from './testing';

/** Whether `name` is a table in the database `db` reads. */
async function hasTable(db: Kysely<DB>, name: string): Promise<boolean> {
  const row = await sql<{
    found: string | null;
  }>`select to_regclass(${name})::text as found`.execute(db);
  return row.rows[0]?.found != null;
}

async function hasPgTable(pg: PGlite, name: string): Promise<boolean> {
  const result = await pg.query<{ found: string | null }>('select to_regclass($1)::text as found', [
    name,
  ]);
  return result.rows[0]?.found != null;
}

test('every Postgres test store is migrated and a database of its own', async () => {
  const a = await createPgliteTestStore();
  const b = await createPgliteTestStore();
  try {
    expect(await readSchemaVersion(a.db)).toBe(SCHEMA_VERSION);
    expect(await readSchemaVersion(b.db)).toBe(SCHEMA_VERSION);
    await sql`create table only_in_a (x int)`.execute(a.db);
    expect(await hasTable(a.db, 'only_in_a')).toBe(true);
    expect(await hasTable(b.db, 'only_in_a')).toBe(false);
    const c = await createPgliteTestStore();
    try {
      expect(await hasTable(c.db, 'only_in_a')).toBe(false);
    } finally {
      await c.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test('every empty Postgres test database has no schema and is a database of its own', async () => {
  const a = await createEmptyPglite();
  const b = await createEmptyPglite();
  try {
    expect(await hasPgTable(a, 'schema_version')).toBe(false);
    await a.exec('create table only_in_a (x int)');
    expect(await hasPgTable(a, 'only_in_a')).toBe(true);
    expect(await hasPgTable(b, 'only_in_a')).toBe(false);
  } finally {
    await a.close();
    await b.close();
  }
});
