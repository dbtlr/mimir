import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';

import type { Store } from '../store';
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
