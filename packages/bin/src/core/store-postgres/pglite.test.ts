import { expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';
import type { Generated } from 'kysely';
import { Kysely, sql } from 'kysely';

import { createPgliteDialect } from './pglite';

type Row = { id: string; n: Generated<number> };
type TestDB = { t: Row };

async function freshDb(): Promise<{ db: Kysely<TestDB>; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db = new Kysely<TestDB>({ dialect: createPgliteDialect(pg) });
  await sql`create table t (id text primary key, n int not null default 0)`.execute(db);
  return { close: () => db.destroy(), db };
}

test('the pglite dialect round-trips a typed insert and select', async () => {
  const { close, db } = await freshDb();
  try {
    await db.insertInto('t').values({ id: 'a', n: 1 }).execute();
    expect(await db.selectFrom('t').selectAll().execute()).toEqual([{ id: 'a', n: 1 }]);
  } finally {
    await close();
  }
});

test('the pglite dialect reports the rows a write affected', async () => {
  const { close, db } = await freshDb();
  try {
    await db
      .insertInto('t')
      .values([{ id: 'a' }, { id: 'b' }])
      .execute();
    const result = await db.updateTable('t').set({ n: 2 }).executeTakeFirst();
    expect(result.numUpdatedRows).toBe(2n);
  } finally {
    await close();
  }
});

test('beginTransaction honors the requested isolation level', async () => {
  const { close, db } = await freshDb();
  try {
    const level = await db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (tx) => {
        const row = await sql<{
          transaction_isolation: string;
        }>`show transaction_isolation`.execute(tx);
        return row.rows[0]?.transaction_isolation;
      });
    expect(level).toBe('serializable');
  } finally {
    await close();
  }
});

test('a throw inside a transaction rolls the whole scope back', async () => {
  const { close, db } = await freshDb();
  try {
    await db.insertInto('t').values({ id: 'a' }).execute();
    const failure = db.transaction().execute(async (tx) => {
      await tx.updateTable('t').set({ n: 99 }).where('id', '=', 'a').execute();
      throw new Error('rollback me');
    });
    expect(await failure.then(() => 'resolved').catch((e: Error) => e.message)).toBe('rollback me');
    expect(await db.selectFrom('t').select('n').executeTakeFirst()).toEqual({ n: 0 });
  } finally {
    await close();
  }
});
