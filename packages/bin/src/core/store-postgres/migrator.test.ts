import { expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';

import { MimirError } from '../errors';
import { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './migrator';
import { createPgliteDialect } from './pglite';
import type { DB } from './schema';

function freshDb(): Kysely<DB> {
  return new Kysely<DB>({ dialect: createPgliteDialect(new PGlite()) });
}

async function refusalOf(action: Promise<unknown>): Promise<MimirError> {
  const error = await action.then(
    () => new Error('expected a refusal'),
    (reason: unknown) => reason,
  );
  if (!(error instanceof MimirError)) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return error;
}

test('a fresh database carries no schema version and refuses every read', async () => {
  const db = freshDb();
  try {
    expect(await readSchemaVersion(db)).toBeNull();
    const refusal = await refusalOf(assertSchemaCurrent(db));
    expect(refusal.message).toBe('the Postgres store has no schema');
    expect(refusal.hint).toBe("run 'mimir store upgrade' to create it");
  } finally {
    await db.destroy();
  }
});

test('an upgrade names the migrations it applied and lands the current version', async () => {
  const db = freshDb();
  try {
    expect(await upgradeSchema(db)).toEqual({
      applied: ['0001_init'],
      from: 0,
      to: SCHEMA_VERSION,
    });
    expect(await readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    await assertSchemaCurrent(db);
    // Idempotent: a second upgrade of a current store applies nothing.
    expect(await upgradeSchema(db)).toEqual({
      applied: [],
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
    });
  } finally {
    await db.destroy();
  }
});

test('a schema newer than the binary is refused, and never downgraded', async () => {
  const db = freshDb();
  try {
    await upgradeSchema(db);
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION + 1 })
      .execute();
    expect((await refusalOf(assertSchemaCurrent(db))).message).toContain(
      `is version ${String(SCHEMA_VERSION + 1)}`,
    );
    expect((await refusalOf(upgradeSchema(db))).hint).toBe(
      'upgrade the binary; a newer schema is never downgraded',
    );
  } finally {
    await db.destroy();
  }
});

test('a schema older than the binary is refused, and points at the explicit upgrade', async () => {
  const db = freshDb();
  try {
    await upgradeSchema(db);
    await db.deleteFrom('schema_version').where('version', '=', SCHEMA_VERSION).execute();
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION - 1 })
      .execute();
    const refusal = await refusalOf(assertSchemaCurrent(db));
    expect(refusal.message).toContain(`this binary needs version ${String(SCHEMA_VERSION)}`);
    expect(refusal.hint).toContain('mimir store upgrade');
  } finally {
    await db.destroy();
  }
});

test('an upgrade skips a migration whose version is already recorded', async () => {
  const db = freshDb();
  try {
    // The state the LOSER of an upgrade race sees when it re-reads inside the
    // advisory lock: the version is already there, so the migration must not
    // run a second time. (The race itself belongs to the real-Postgres lane —
    // PGlite is one session, so two connections cannot contend here.)
    await sql`create table schema_version (version integer primary key, applied_at text not null)`.execute(
      db,
    );
    await db
      .insertInto('schema_version')
      .values({ applied_at: '2026-09-01T00:00:00.000Z', version: SCHEMA_VERSION })
      .execute();
    expect(await upgradeSchema(db)).toEqual({
      applied: [],
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
    });
    // The migration's own tables were never created, so nothing re-ran.
    const present = await sql<{
      present: string | null;
    }>`select to_regclass('project')::text as present`.execute(db);
    expect(present.rows[0]?.present).toBeNull();
  } finally {
    await db.destroy();
  }
});
