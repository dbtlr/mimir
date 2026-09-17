import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';

import type { Store } from '../store';
import { openPostgres } from './client';
import { upgradeSchema } from './migrator';
import { createPgliteDialect } from './pglite';
import type { DB } from './schema';
import { createPostgresStore } from './store';

/**
 * A fresh, migrated Postgres store in this process — the fixture the conformance
 * suites run the Postgres arm on.
 *
 * PGlite rather than a server because the suite must run everywhere: a test lane
 * that needs a database on the runner is a lane that skips, and a skipped
 * conformance arm proves nothing. It is real PostgreSQL, so the constraints,
 * the isolation level, and the SQLSTATEs under test are the real ones.
 */
export type PostgresTestStore = {
  store: Store;
  db: Kysely<DB>;
  close: () => Promise<void>;
};

export async function createPgliteTestStore(): Promise<PostgresTestStore> {
  const db = new Kysely<DB>({ dialect: createPgliteDialect(new PGlite()) });
  try {
    await upgradeSchema(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return { close: () => db.destroy(), db, store: createPostgresStore(db) };
}

/**
 * A throwaway schema on a real Postgres server, and the handle that removes it.
 *
 * The real-Postgres lane needs isolation without a database per case, so each
 * case gets its own SQL schema and a connection URL pinned to it through
 * libpq's `options=-c search_path=...`. Every unqualified name the backend uses
 * — including `to_regclass('schema_version')`, the fresh-store probe — then
 * resolves inside that schema, so a lane run neither sees nor disturbs anything
 * else in the database.
 */
export type ThrowawaySchema = {
  name: string;
  /** The connection URL with `search_path` pinned to {@link name}. */
  url: string;
  drop: () => Promise<void>;
};

/** `url` with libpq `options` pinning the session search path to `schema`. */
function withSearchPath(url: string, schema: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

export async function createThrowawaySchema(url: string): Promise<ThrowawaySchema> {
  const name = `mimir_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = openPostgres(url);
  try {
    await sql.raw(`CREATE SCHEMA ${name}`).execute(admin.db);
  } finally {
    await admin.close();
  }
  return {
    drop: async () => {
      const cleanup = openPostgres(url);
      try {
        await sql.raw(`DROP SCHEMA ${name} CASCADE`).execute(cleanup.db);
      } finally {
        await cleanup.close();
      }
    },
    name,
    url: withSearchPath(url, name),
  };
}
